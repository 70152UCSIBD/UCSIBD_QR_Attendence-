const { createClient } = require('@supabase/supabase-js');
const { isIPv4 } = require('net');
const IPCIDR = require('ip-cidr-check'); // For IP-CIDR matching
const pointInPolygon = require('point-in-polygon'); // For geofence checking

// Initialize Supabase client for server-side
// Use the SUPABASE_SERVICE_KEY for full admin access on the backend
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Supabase URL or Service Key is missing. Check Netlify environment variables.');
  process.exit(1); // Exit if critical env vars are missing
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Environment variables for validation logic
const ALLOWED_EMAIL_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || 'ucsi.edu.bd';
const SESSION_CLOSE_TIMEOUT_MINUTES = parseInt(process.env.SESSION_CLOSE_TIMEOUT_MINUTES || '30', 10);

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  try {
    const { qrToken, gpsData, userId, timestamp, isManualEntry } = JSON.parse(event.body);

    if (!qrToken || !userId || !timestamp) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required parameters: qrToken, userId, timestamp' }),
      };
    }

    let validationStatus = 'flagged'; // Default to flagged
    let validationMethod = 'manual'; // Default to manual for safety, will be updated

    // Validate GPS data if provided
    let parsedLat = null;
    let parsedLng = null;
    if (gpsData && typeof gpsData.latitude === 'number' && typeof gpsData.longitude === 'number') {
      // Basic check for plausible lat/lng ranges
      if (gpsData.latitude >= -90 && gpsData.latitude <= 90 &&
          gpsData.longitude >= -180 && gpsData.longitude <= 180) {
        parsedLat = gpsData.latitude;
        parsedLng = gpsData.longitude;
      } else {
        console.warn('Invalid GPS coordinates provided:', gpsData);
      }
    }

    const clientIp = event.headers['client-ip'] || event.headers['x-nf-client-connection-ip']; // Netlify specific headers
    console.log('Client IP:', clientIp);

    // 1. Fetch User Profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, email, gps_consent_signed')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      console.error('Profile fetch error:', profileError);
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'User profile not found or unauthorized.' }),
      };
    }

    if (!profile.email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: `Unauthorized email domain. Must be @${ALLOWED_EMAIL_DOMAIN}` }),
      };
    }

    // 2. Fetch Classroom and Building Data
    const { data: classroom, error: classroomError } = await supabase
      .from('classrooms')
      .select('id, building_id, geofence_polygon, room_name, latitude, longitude')
      .eq('qr_token', qrToken)
      .single();

    if (classroomError || !classroom) {
      console.error('Classroom fetch error:', classroomError);
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Invalid QR token or classroom not found.' }),
      };
    }

    const { data: building, error: buildingError } = await supabase
      .from('buildings')
      .select('id, name, campus_wifi_subnets')
      .eq('id', classroom.building_id)
      .single();

    if (buildingError || !building) {
      console.error('Building fetch error:', buildingError);
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Building information not found for classroom.' }),
      };
    }

    // 3. Schedule Check
    const scannedTime = new Date(timestamp);
    const dayOfWeek = scannedTime.getUTCDay(); // 0 for Sunday, 6 for Saturday
    const timeOnly = scannedTime.toUTCString().split(' ')[4]; // "HH:MM:SS"

    const { data: schedules, error: scheduleError } = await supabase
      .from('schedules')
      .select('id')
      .eq('faculty_id', userId)
      .eq('classroom_id', classroom.id)
      .eq('day_of_week', dayOfWeek)
      .lte('start_time', timeOnly) // Scanned time must be after or at start time
      .gte('end_time', timeOnly); // Scanned time must be before or at end time

    if (scheduleError || !schedules || schedules.length === 0) {
      // Allow manual entry to bypass schedule check if it's the specific scenario.
      // The spec states "If this check fails, reject immediately. No further checks are performed."
      // Manual entry fallback is "flagged as manual_entry and routed to the admin review queue."
      // So, if it's manual entry, we can potentially proceed, but if it's a QR scan and schedule fails, it's rejected.
      if (isManualEntry) {
        validationStatus = 'manual_entry';
        validationMethod = 'manual';
      } else {
        console.warn('Schedule check failed for user:', userId, 'classroom:', classroom.room_name, 'at:', timestamp);
        return {
          statusCode: 403,
          body: JSON.stringify({ error: 'Not scheduled in this room at this time.' }),
        };
      }
    } else {
      // Schedule check passed for QR scan or valid manual entry
      validationMethod = isManualEntry ? 'manual' : 'qr_scan'; // Initial method, will be refined by context checks
    }

    let isNetworkVerified = false;
    let isLocationVerified = false;

    // 4. Context Check (Fallback OR Logic)
    // a. Network Check: Does client IP match campus WiFi subnets?
    if (clientIp && isIPv4(clientIp) && building.campus_wifi_subnets && building.campus_wifi_subnets.length > 0) {
      for (const cidr of building.campus_wifi_subnets) {
        try {
          const ipCidr = new IPCIDR(cidr);
          if (ipCidr.check(clientIp)) {
            isNetworkVerified = true;
            break;
          }
        } catch (ipCidrError) {
          console.error(`Invalid CIDR format in DB: ${cidr}`, ipCidrError);
          // Continue to next CIDR or assume false
        }
      }
    }

    // b. Location Check: Do GPS coordinates fall inside the building's geofence polygon?
    if (parsedLat !== null && parsedLng !== null && profile.gps_consent_signed && classroom.geofence_polygon) {
      try {
        // point-in-polygon expects [longitude, latitude] for point and [[lng, lat], ...] for polygon vertices
        // DB stores geofence_polygon as JSON array of [lat, lng] vertices, e.g., [[lat1, lng1], ...]
        const polygonCoords = classroom.geofence_polygon.map((vertex) => [vertex[1], vertex[0]]); // Transform to [[lng, lat], ...]
        const point = [parsedLng, parsedLat];

        if (pointInPolygon(point, polygonCoords)) {
          isLocationVerified = true;
        }
      } catch (polygonError) {
        console.error('Error during point-in-polygon check:', polygonError);
      }
    }

    // 5. Resolution
    if (!isManualEntry && schedules && schedules.length > 0) { // Only apply this if not manual entry and schedule passed
      if (isNetworkVerified || isLocationVerified) {
        validationStatus = 'verified';
        validationMethod = isNetworkVerified && isLocationVerified ? 'ip_gps' : (isNetworkVerified ? 'ip' : 'gps');
      } else {
        validationStatus = 'flagged';
        validationMethod = isNetworkVerified && isLocationVerified ? 'ip_gps' : (isNetworkVerified ? 'ip' : 'gps'); // Still mark method but status flagged
        if (!isNetworkVerified && !isLocationVerified) {
            validationMethod = 'unknown_context'; // More specific for flagging reasons
        }
      }
    } else if (isManualEntry) {
      validationStatus = 'manual_entry';
      validationMethod = 'manual';
    }


    // Prepare data for insertion
    const attendanceLogData = {
      faculty_id: userId,
      classroom_id: classroom.id,
      scanned_at: timestamp,
      status: validationStatus,
      validation_method: validationMethod,
      // Store raw IP and GPS. Supabase pgcrypto extension should be configured
      // on the database side (e.g., via triggers or RLS functions) to encrypt these BYTEA columns.
      // Example SQL function/trigger in Supabase:
      // CREATE FUNCTION encrypt_attendance_data()
      // RETURNS TRIGGER AS $$
      // BEGIN
      //   NEW.ip_address := PGCRYPTO_ENCRYPT(NEW.ip_address::bytea, 'YOUR_ENCRYPTION_KEY', 'aes');
      //   NEW.gps_lat := PGCRYPTO_ENCRYPT(NEW.gps_lat::bytea, 'YOUR_ENCRYPTION_KEY', 'aes');
      //   NEW.gps_lng := PGCRYPTO_ENCRYPT(NEW.gps_lng::bytea, 'YOUR_ENCRYPTION_KEY', 'aes');
      //   RETURN NEW;
      // END;
      // $$ LANGUAGE plpgsql;
      //
      // CREATE TRIGGER encrypt_attendance_trigger
      // BEFORE INSERT OR UPDATE ON attendance_logs
      // FOR EACH ROW EXECUTE FUNCTION encrypt_attendance_data();
      ip_address: clientIp, // Raw IP as string
      gps_lat: parsedLat !== null ? String(parsedLat) : null, // Raw latitude as string
      gps_lng: parsedLng !== null ? String(parsedLng) : null, // Raw longitude as string
    };

    if (!profile.gps_consent_signed && (parsedLat !== null || parsedLng !== null)) {
      // If no consent, do not store GPS, even if received
      attendanceLogData.gps_lat = null;
      attendanceLogData.gps_lng = null;
      console.warn('GPS data received but not stored due to missing consent for user:', userId);
    }
    
    // Convert raw IP/GPS data to Buffer if your pgcrypto trigger/function expects bytea directly from JS
    // For direct text to bytea conversion, the DB typically handles it. If you need explicit JS Buffer:
    // attendanceLogData.ip_address = clientIp ? Buffer.from(clientIp, 'utf8') : null;
    // attendanceLogData.gps_lat = parsedLat !== null ? Buffer.from(String(parsedLat), 'utf8') : null;
    // attendanceLogData.gps_lng = parsedLng !== null ? Buffer.from(String(parsedLng), 'utf8') : null;


    const { data: attendanceLog, error: logError } = await supabase
      .from('attendance_logs')
      .insert([attendanceLogData])
      .select()
      .single();

    if (logError || !attendanceLog) {
      console.error('Attendance log insertion error:', logError);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to record attendance.', details: logError.message }),
      };
    }

    // If status is flagged, add to flagged_review_queue
    if (validationStatus === 'flagged' || validationStatus === 'manual_entry') {
      const { error: flaggedError } = await supabase
        .from('flagged_review_queue')
        .insert([{
          attendance_log_id: attendanceLog.id,
          created_at: new Date().toISOString(),
          sla_deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours from now
        }]);

      if (flaggedError) {
        console.error('Failed to add to flagged review queue:', flaggedError);
        // Do not fail the main request, just log this error
      }
    }

    // Schedule the session close ping (T+20 minutes)
    // This could be done using a Netlify scheduled function or a simple background fetch from the client PWA
    // For now, we will rely on the PWA to send a T+20 ping as per spec.
    // The /api/session-close endpoint will handle the update.
    // This function only records the initial scan.

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Attendance ${validationStatus}. Log ID: ${attendanceLog.id}.`,
        status: validationStatus,
      }),
    };
  } catch (parseError) {
    console.error('Request parsing error:', parseError);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid request body format.', details: parseError.message }),
    };
  }
};
