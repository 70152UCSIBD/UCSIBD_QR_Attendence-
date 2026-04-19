const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

/**
 * Session close (T+20 minutes) — updates attendance_logs.session_closed_at
 * per Faculty Attendance v2.0 §4 / Pivot 6.
 */
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
    const { attendanceLogId, userId } = body;

    if (!attendanceLogId || !userId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing attendanceLogId or userId.' }),
      };
    }

    const { data: log, error: fetchError } = await supabase
      .from('attendance_logs')
      .select('id, faculty_id, session_closed_at')
      .eq('id', attendanceLogId)
      .single();

    if (fetchError || !log) {
      console.error('Attendance log fetch error:', fetchError);
      return { statusCode: 404, body: JSON.stringify({ error: 'Attendance record not found.' }) };
    }

    if (log.faculty_id !== userId) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Not allowed to update this attendance record.' }) };
    }

    if (log.session_closed_at) {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Session already closed.', attendanceLogId: log.id }),
      };
    }

    const closedAt = new Date().toISOString();
    const { error: updateError } = await supabase
      .from('attendance_logs')
      .update({ session_closed_at: closedAt })
      .eq('id', attendanceLogId)
      .eq('faculty_id', userId);

    if (updateError) {
      console.error('Session close update error:', updateError);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to update session.', details: updateError.message }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Session close recorded.',
        attendanceLogId,
        sessionClosedAt: closedAt,
      }),
    };
  } catch (err) {
    console.error('session-close error:', err);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid request.', details: err.message }),
    };
  }
};
