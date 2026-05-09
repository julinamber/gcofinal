const { getPool } = require("../config/db");
const { sendAppointmentEmail } = require("./gmailService");

/**
 * Auto-reminder system for upcoming appointments.
 *
 * Fires once per (appointment, reminder_type):
 *   - 1day:  appointment is within ~24h ± tolerance window
 *   - 1hour: appointment is within ~1h ± tolerance window
 *
 * Notifies BOTH the student and the counselor (in-app + email).
 * Message includes: date, time, student name, service type.
 */

const POLL_INTERVAL_MS = Number(process.env.REMINDER_POLL_INTERVAL_MS || 60 * 1000); // every minute
const TOLERANCE_MIN = Number(process.env.REMINDER_TOLERANCE_MIN || 5);

let timer = null;

function formatDateLabel(dateValue, timeValue) {
  const d = String(dateValue).slice(0, 10);
  const t = String(timeValue || "").slice(0, 5);
  return `${d} at ${t}`;
}

async function findDueAppointments(db, type) {
  const intervalMin = type === "1day" ? 24 * 60 : 60;
  const lower = intervalMin - TOLERANCE_MIN;
  const upper = intervalMin + TOLERANCE_MIN;
  const [rows] = await db.query(
    `SELECT a.id, a.booking_code, a.appointment_date, a.appointment_time, a.service_type,
            s.id AS student_id, s.full_name AS student_name, s.email AS student_email,
            c.id AS counselor_id, c.full_name AS counselor_name, c.email AS counselor_email,
            TIMESTAMPDIFF(MINUTE, NOW(),
              TIMESTAMP(a.appointment_date, a.appointment_time)) AS minutes_until
       FROM appointments a
       JOIN users s ON s.id = a.student_id
       JOIN users c ON c.id = a.counselor_id
       LEFT JOIN appointment_reminders r
         ON r.appointment_id = a.id AND r.reminder_type = ?
      WHERE a.status = 'accepted'
        AND r.id IS NULL
        AND TIMESTAMP(a.appointment_date, a.appointment_time) > NOW()
       HAVING minutes_until BETWEEN ? AND ?`,
    [type, lower, upper]
  );
  return rows;
}

async function recordSent(db, appointmentId, type) {
  try {
    await db.query(
      "INSERT INTO appointment_reminders (appointment_id, reminder_type) VALUES (?, ?)",
      [appointmentId, type]
    );
  } catch (err) {
    if (err.code !== "ER_DUP_ENTRY") throw err;
  }
}

async function notifyOne(db, appt, type) {
  const whenLabel = formatDateLabel(appt.appointment_date, appt.appointment_time);
  const heading = type === "1day" ? "Reminder: appointment tomorrow" : "Reminder: appointment in 1 hour";
  const studentMsg = `Your counseling session is on ${whenLabel}. Service type: ${appt.service_type}. Counselor: ${appt.counselor_name}. Booking code: ${appt.booking_code}.`;
  const counselorMsg = `Upcoming appointment on ${whenLabel}. Student: ${appt.student_name}. Service type: ${appt.service_type}. Booking code: ${appt.booking_code}.`;

  await db.query(
    `INSERT INTO notifications (user_id, appointment_id, title, message, type)
     VALUES (?, ?, ?, ?, 'info')`,
    [appt.student_id, appt.id, heading, studentMsg]
  );
  await db.query(
    `INSERT INTO notifications (user_id, appointment_id, title, message, type)
     VALUES (?, ?, ?, ?, 'info')`,
    [appt.counselor_id, appt.id, heading, counselorMsg]
  );

  if (appt.student_email) {
    await sendAppointmentEmail({ to: appt.student_email, subject: heading, text: studentMsg });
  }
  if (appt.counselor_email) {
    await sendAppointmentEmail({ to: appt.counselor_email, subject: heading, text: counselorMsg });
  }
}

async function runOnce() {
  const db = getPool();
  for (const type of ["1day", "1hour"]) {
    let due = [];
    try {
      due = await findDueAppointments(db, type);
    } catch (err) {
      console.error(`[reminders] query failed for ${type}:`, err.message);
      continue;
    }
    for (const appt of due) {
      try {
        await notifyOne(db, appt, type);
        await recordSent(db, appt.id, type);
        console.log(`[reminders] sent ${type} reminder for appointment ${appt.booking_code}`);
      } catch (err) {
        console.error(`[reminders] failed for appointment ${appt.id}:`, err.message);
      }
    }
  }
}

function startReminderService() {
  if (timer) return;
  timer = setInterval(() => {
    runOnce().catch((err) => console.error("[reminders] tick error:", err.message));
  }, POLL_INTERVAL_MS);
  setTimeout(() => {
    runOnce().catch((err) => console.error("[reminders] startup tick error:", err.message));
  }, 5000);
  console.log(`[reminders] auto-reminder service started (every ${POLL_INTERVAL_MS / 1000}s).`);
}

function stopReminderService() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startReminderService, stopReminderService, runOnce };
