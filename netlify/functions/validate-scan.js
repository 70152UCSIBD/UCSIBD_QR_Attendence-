const { createClient } = require('@supabase/supabase-js');
const { isIPv4 } = require('net');
const IPCIDR = require('ip-cidr');
const pointInPolygon = require('point-in-polygon');

const BDT_TZ = 'Asia/Dhaka';
const SCHEDULE_MARGIN_MINUTES = 15;

const ALLOWED_EMAIL_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || 'ucsi.edu.bd';

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function getClientIp(event) {
  const h = event.headers || {};
  const forwarded = h['x-forwarded-for'] || h['X-Forwarded-For'];
  if (forwarded) {
    return String(forwarded).split(',')[0].trim();
  }
  return h['client-ip'] || h['x-nf-client-connection-ip'] || h['X-NF-Client-Connection-IP'] || null;
}

function getBdtCalendarDate(isoString) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BDT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(isoString));
}

function getBdtDayOfWeek(isoString) {
  const d = new Date(isoString);
  const w = new Intl.DateTimeFormat('en-US', { timeZone: BDT_TZ, weekday: 'short' }).format(d);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[w] ?? 0;
}

function getBdtMinutesFromMidnight(isoString) {
  const d = new Date(isoString);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: BDT_TZ,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute').value, 10);
  const second = parseInt(parts.find((p) => p.type === 'second').value, 10);
  return hour * 60 + minute + second / 60;
}

function timeStrToMinutes(t) {
  if (t == null) return null;
  const s = typeof t === 'string' ? t : String(t);
  const parts = s.split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const sec = parts[2] != null ? parseInt(parts[2], 10) : 0;
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m + (Number.isNaN(sec) ? 0 : sec) / 60;
}

function scheduleMatches(rows, scanDateStr, scanMinutes) {
  if (!rows || !rows.length) return false;
  for (const row of rows) {
    if (row.effective_from && scanDateStr < row.effective_from) continue;
    if (row.effective_until && scanDateStr > row.effective_until) continue;
    const startM = timeStrToMinutes(row.start_time);
    const endM = timeStrToMinutes(row.end_time);
    if (startM == null || endM == null) continue;
    if (scanMinutes >= startM - SCHEDULE_MARGIN_MINUTES && scanMinutes <= endM + SCHEDULE_MARGIN_MINUTES) {
      return true;
    }
  }
  return false;
}

function pickGeofencePolygon(building, classroom) {
  if (building && building.geofence_polygon && Array.isArray(building.geofence_polygon)) {
    return building.geofence_polygon;
  }
  if (classroom && classroom.geofence_polygon && Array.isArray(classroom.geofence_polygon)) {
    return classroom.geofence_polygon;
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const supabase = getSupabase();
  if (!supabase) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { qrToken, gpsData, userId, timestamp, isManualEntry } = body;

    if (!qrToken || !userId || !timestamp) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required parameters: qrToken, userId, timestamp' }),
      };
    }

    let parsedLat = null;
    let parsedLng = null;
    if (gpsData && typeof gpsData.latitude === 'number' && typeof gpsData.longitude === 'number') {
      if (
        gpsData.latitude >= -90 &&
        gpsData.latitude <= 90 &&
        gpsData.longitude >= -180 &&
        gpsData.longitude <= 180
      ) {
        parsedLat = gpsData.latitude;
        parsedLng = gpsData.longitude;
      } else {
        console.warn('Invalid GPS coordinates provided:', gpsData);
      }
    }

    const clientIp = getClientIp(event);

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, email, gps_consent_signed')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      console.error('Profile fetch error:', profileError);
      return { statusCode: 401, body: JSON.stringify({ error: 'User profile not found or unauthorized.' }) };
    }

    const email = (profile.email || '').toLowerCase();
    if (!email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: `Unauthorized email domain. Must be @${ALLOWED_EMAIL_DOMAIN}` }),
      };
    }

    const { data: classroom, error: classroomError } = await supabase
      .from('classrooms')
      .select('id, building_id, geofence_polygon, room_name, latitude, longitude')
      .eq('qr_token', qrToken)
      .single();

    if (classroomError || !classroom) {
      console.error('Classroom fetch error:', classroomError);
      return { statusCode: 404, body: JSON.stringify({ error: 'Invalid QR token or classroom not found.' }) };
    }

    const { data: building, error: buildingError } = await supabase
      .from('buildings')
      .select('id, name, campus_wifi_subnets, geofence_polygon')
      .eq('id', classroom.building_id)
      .single();

    if (buildingError || !building) {
      console.error('Building fetch error:', buildingError);
      return { statusCode: 404, body: JSON.stringify({ error: 'Building information not found for classroom.' }) };
    }

    const scanDateStr = getBdtCalendarDate(timestamp);
    const dayOfWeek = getBdtDayOfWeek(timestamp);
    const scanMinutes = getBdtMinutesFromMidnight(timestamp);

    const { data: scheduleRows, error: scheduleError } = await supabase
      .from('schedules')
      .select('id, start_time, end_time, day_of_week, effective_from, effective_until')
      .eq('faculty_id', userId)
      .eq('classroom_id', classroom.id)
      .eq('day_of_week', dayOfWeek);

    if (scheduleError) {
      console.error('Schedule fetch error:', scheduleError);
      return { statusCode: 500, body: JSON.stringify({ error: 'Server error while checking schedule.' }) };
    }

    const scheduleOk = scheduleMatches(scheduleRows || [], scanDateStr, scanMinutes);

    if (!isManualEntry && !scheduleOk) {
      console.warn('Schedule check failed for user:', userId, 'classroom:', classroom.room_name, 'at:', timestamp);
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Not scheduled in this room at this time.' }),
      };
    }

    if (isManualEntry) {
      const attendanceLogData = {
        faculty_id: userId,
        classroom_id: classroom.id,
        scanned_at: timestamp,
        status: 'manual_entry',
        validation_method: 'manual',
        ip_address: clientIp || null,
        gps_lat: null,
        gps_lng: null,
      };

      const { data: attendanceLog, error: logError } = await supabase
        .from('attendance_logs')
        .insert([attendanceLogData])
        .select()
        .single();

      if (logError || !attendanceLog) {
        console.error('Attendance log insertion error:', logError);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: 'Failed to record attendance.', details: logError && logError.message }),
        };
      }

      const { error: flaggedError } = await supabase.from('flagged_review_queue').insert([
        {
          attendance_log_id: attendanceLog.id,
          created_at: new Date().toISOString(),
          sla_deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
      ]);

      if (flaggedError) {
        console.error('Failed to add manual entry to review queue:', flaggedError);
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'Manual attendance submitted for review.',
          status: 'manual_entry',
          attendanceLogId: attendanceLog.id,
        }),
      };
    }

    const consent = profile.gps_consent_signed === true;
    if (!consent && parsedLat !== null) {
      parsedLat = null;
      parsedLng = null;
    }

    let isNetworkVerified = false;
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
        }
      }
    }

    let isLocationVerified = false;
    const polygon = pickGeofencePolygon(building, classroom);
    if (parsedLat !== null && parsedLng !== null && consent && polygon && polygon.length >= 3) {
      try {
        const polygonCoords = polygon.map((vertex) => [vertex[1], vertex[0]]);
        const point = [parsedLng, parsedLat];
        if (pointInPolygon(point, polygonCoords)) {
          isLocationVerified = true;
        }
      } catch (polygonError) {
        console.error('Error during point-in-polygon check:', polygonError);
      }
    }

    let validationStatus;
    if (isNetworkVerified || isLocationVerified) {
      validationStatus = 'verified';
    } else {
      validationStatus = 'flagged';
    }

    let validationMethod;
    if (validationStatus === 'verified') {
      validationMethod = isNetworkVerified ? 'ip' : 'gps';
    } else {
      validationMethod = parsedLat !== null && consent ? 'gps' : 'ip';
    }

    const attendanceLogData = {
      faculty_id: userId,
      classroom_id: classroom.id,
      scanned_at: timestamp,
      status: validationStatus,
      validation_method: validationMethod,
      ip_address: clientIp || null,
      gps_lat: consent && parsedLat !== null ? String(parsedLat) : null,
      gps_lng: consent && parsedLng !== null ? String(parsedLng) : null,
    };

    const { data: attendanceLog, error: logError } = await supabase
      .from('attendance_logs')
      .insert([attendanceLogData])
      .select()
      .single();

    if (logError || !attendanceLog) {
      console.error('Attendance log insertion error:', logError);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to record attendance.', details: logError && logError.message }),
      };
    }

    if (validationStatus === 'flagged') {
      const { error: flaggedError } = await supabase.from('flagged_review_queue').insert([
        {
          attendance_log_id: attendanceLog.id,
          created_at: new Date().toISOString(),
          sla_deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
      ]);

      if (flaggedError) {
        console.error('Failed to add to flagged review queue:', flaggedError);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message:
          validationStatus === 'verified'
            ? 'Attendance verified.'
            : 'Attendance recorded; flagged for review (location or network could not be verified).',
        status: validationStatus,
        attendanceLogId: attendanceLog.id,
      }),
    };
  } catch (parseError) {
    console.error('Request error:', parseError);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid request.', details: parseError.message }),
    };
  }
};
