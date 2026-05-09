const express = require("express");
const { getPool } = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { sendAppointmentEmail } = require("../services/gmailService");
const { syncAppointmentToSheet } = require("../services/sheetsService");

const router = express.Router();

router.use(requireAuth);

async function insertNotification(db, { userId, appointmentId, title, message, type = "info" }) {
  await db.query(
    `INSERT INTO notifications (user_id, appointment_id, title, message, type)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, appointmentId, title, message, type]
  );
}

async function getAdminUsers(db) {
  const [admins] = await db.query("SELECT id, email, full_name FROM users WHERE role = 'admin' AND is_active = 1");
  return admins;
}

router.get("/my", async (req, res) => {
  const db = getPool();
  let query = `
    SELECT a.id, a.booking_code, a.service_type, a.reason, a.student_cancellation_reason,
           a.year_level, a.college,
           a.outcome, a.outcome_at, a.outcome_note,
           a.appointment_date, a.appointment_time, a.status,
           s.full_name AS student_name, c.full_name AS counselor_name
    FROM appointments a
    JOIN users s ON s.id = a.student_id
    JOIN users c ON c.id = a.counselor_id
  `;
  const params = [];

  if (req.user.role === "student") {
    query += " WHERE a.student_id = ?";
    params.push(req.user.id);
  } else if (req.user.role === "counselor") {
    query += " WHERE a.counselor_id = ?";
    params.push(req.user.id);
  }

  query += " ORDER BY a.appointment_date, a.appointment_time";
  const [rows] = await db.query(query, params);
  res.json(rows);
});

router.post("/", requireRole("student"), async (req, res) => {
  const { counselorId, serviceType, date, time, reason, yearLevel, college } = req.body;
  if (!counselorId || !serviceType || !date || !time || !yearLevel || !college) {
    return res.status(400).json({ message: "Missing required booking fields" });
  }

  const allowedStartTimes = new Set(["07:30", "09:00", "10:30", "13:00", "14:30"]);
  const timeHHMM = String(time).slice(0, 5);
  if (!allowedStartTimes.has(timeHHMM)) {
    return res.status(400).json({ message: "Invalid time slot. Please choose an available slot." });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const requestedDate = new Date(`${date}T00:00:00`);
  if (Number.isNaN(requestedDate.getTime())) return res.status(400).json({ message: "Invalid appointment date." });
  if (requestedDate < today) return res.status(400).json({ message: "Cannot book past dates." });

  const db = getPool();
  const sessionEnd = (() => {
    const [h, m] = timeHHMM.split(":").map(Number);
    const startMin = h * 60 + m;
    const endMin = startMin + 60;
    const eh = String(Math.floor(endMin / 60)).padStart(2, "0");
    const em = String(endMin % 60).padStart(2, "0");
    return `${eh}:${em}:00`;
  })();
  const [blocked] = await db.query(
    `SELECT id, start_time, end_time FROM counselor_unavailabilities
     WHERE counselor_id = ? AND unavailable_date = ?`,
    [counselorId, date]
  );
  const conflictingBlock = blocked.find((row) => {
    if (!row.start_time && !row.end_time) return true;
    const blockStart = row.start_time ? String(row.start_time).slice(0, 8) : "00:00:00";
    const blockEnd = row.end_time ? String(row.end_time).slice(0, 8) : "23:59:59";
    return `${timeHHMM}:00` < blockEnd && sessionEnd > blockStart;
  });
  if (conflictingBlock) {
    return res.status(409).json({ message: "Counselor is unavailable for the selected date/time." });
  }

  // Conflict rule: 1 hour session + 30 minute grace period => 90 minute block
  const [existing] = await db.query(
    `SELECT appointment_time
     FROM appointments
     WHERE counselor_id = ? AND appointment_date = ?
       AND status IN ('pending','accepted')`,
    [counselorId, date]
  );
  const toMinutes = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };
  const newStart = toMinutes(timeHHMM);
  const conflict = existing.some((row) => Math.abs(toMinutes(String(row.appointment_time).slice(0, 5)) - newStart) < 90);
  if (conflict) return res.status(409).json({ message: "Selected slot is no longer available" });

  const bookingCode = `APT-${Date.now().toString().slice(-6)}`;
  const [result] = await db.query(
    `INSERT INTO appointments
     (booking_code, student_id, counselor_id, service_type, reason, year_level, college, appointment_date, appointment_time, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [bookingCode, req.user.id, counselorId, serviceType, reason || null, yearLevel, college, date, timeHHMM]
  );

  await db.query("INSERT INTO audit_logs (actor_id, action, meta) VALUES (?, ?, ?)", [
    req.user.id,
    "appointment_created",
    JSON.stringify({ appointmentId: result.insertId, bookingCode })
  ]);

  await syncAppointmentToSheet([bookingCode, req.user.email, counselorId, serviceType, date, time, "pending"]);
  const [users] = await db.query("SELECT id, full_name, email FROM users WHERE id IN (?, ?)", [req.user.id, counselorId]);
  const student = users.find((u) => u.id === req.user.id);
  const counselor = users.find((u) => u.id === Number(counselorId));
  const admins = await getAdminUsers(db);

  const studentName = student?.full_name || "Student";
  await insertNotification(db, {
    userId: req.user.id,
    appointmentId: result.insertId,
    title: "Booking Submitted",
    message: `Your ${serviceType} session on ${date} at ${timeHHMM} was submitted and is awaiting approval (Ref: ${bookingCode}).`,
    type: "info"
  });
  if (counselor) {
    await insertNotification(db, {
      userId: counselor.id,
      appointmentId: result.insertId,
      title: "New Booking Request",
      message: `${studentName} booked a ${serviceType} session on ${date} at ${timeHHMM} (Ref: ${bookingCode}).`,
      type: "action"
    });
  }
  for (const admin of admins) {
    await insertNotification(db, {
      userId: admin.id,
      appointmentId: result.insertId,
      title: "Booking Created",
      message: `${studentName} booked a ${serviceType} session on ${date} at ${timeHHMM} (Ref: ${bookingCode}).`,
      type: "info"
    });
  }
  await sendAppointmentEmail({
    to: req.user.email,
    subject: "Appointment Request Submitted",
    text: `Your booking ${bookingCode} has been submitted and is awaiting counselor approval.`
  });
  if (counselor?.email) {
    await sendAppointmentEmail({
      to: counselor.email,
      subject: `New booking request (${bookingCode})`,
      text: `${student?.full_name || "Student"} requested an appointment on ${date} at ${timeHHMM}.`
    });
  }

  res.status(201).json({ id: result.insertId, bookingCode });
});

router.patch("/:id/status", requireRole("student", "counselor", "admin"), async (req, res) => {
  const { status } = req.body;
  const allowedByRole = {
    student: ["reschedule_requested"],
    counselor: ["accepted", "declined", "cancelled", "reschedule_requested"],
    admin: ["accepted", "declined", "cancelled", "reschedule_requested"]
  };
  if (!allowedByRole[req.user.role].includes(status)) {
    return res.status(400).json({ message: "Invalid status update for your role" });
  }

  const db = getPool();
  const appointmentId = Number(req.params.id);
  const [apptRows] = await db.query(
    `SELECT a.*, s.email AS student_email, s.full_name AS student_name,
            c.email AS counselor_email, c.full_name AS counselor_name
     FROM appointments a
     JOIN users s ON s.id = a.student_id
     JOIN users c ON c.id = a.counselor_id
     WHERE a.id = ?`,
    [appointmentId]
  );
  const appt = apptRows[0];
  if (!appt) return res.status(404).json({ message: "Appointment not found" });

  if (req.user.role === "counselor" && appt.counselor_id !== req.user.id) {
    return res.status(403).json({ message: "Cannot modify other counselors' appointments" });
  }
  if (req.user.role === "student" && appt.student_id !== req.user.id) {
    return res.status(403).json({ message: "Cannot modify other users' appointments" });
  }

  await db.query("UPDATE appointments SET status = ? WHERE id = ?", [status, appointmentId]);
  await db.query("INSERT INTO audit_logs (actor_id, action, meta) VALUES (?, ?, ?)", [
    req.user.id,
    "appointment_status_updated",
    JSON.stringify({ appointmentId, status })
  ]);

  const statusTitles = {
    accepted: "Appointment Approved",
    declined: "Appointment Declined",
    cancelled: "Appointment Cancelled",
    reschedule_requested: "Reschedule Requested"
  };
  const apptDateStr = String(appt.appointment_date).slice(0, 10);
  const apptTimeStr = String(appt.appointment_time).slice(0, 5);
  const apptLabel = `${appt.service_type} session with ${appt.student_name} on ${apptDateStr} at ${apptTimeStr}`;
  const statusMessages = {
    accepted: `Your ${appt.service_type} session with ${appt.counselor_name} on ${apptDateStr} at ${apptTimeStr} has been approved (Ref: ${appt.booking_code}).`,
    declined: `Your ${appt.service_type} session on ${apptDateStr} at ${apptTimeStr} was declined. Please choose another schedule if needed (Ref: ${appt.booking_code}).`,
    cancelled: `Your ${appt.service_type} session on ${apptDateStr} at ${apptTimeStr} has been cancelled (Ref: ${appt.booking_code}).`,
    reschedule_requested: `A reschedule is needed for your ${appt.service_type} session on ${apptDateStr} at ${apptTimeStr}. Please log in and choose another slot (Ref: ${appt.booking_code}).`
  };

  const admins = await getAdminUsers(db);
  await insertNotification(db, {
    userId: appt.student_id,
    appointmentId,
    title: statusTitles[status],
    message: statusMessages[status],
    type: status === "accepted" ? "success" : status === "reschedule_requested" ? "action" : "warning"
  });
  await insertNotification(db, {
    userId: appt.counselor_id,
    appointmentId,
    title: `Appointment ${status}`,
    message: `${apptLabel} is now ${status} (Ref: ${appt.booking_code}).`,
    type: status === "accepted" ? "success" : status === "reschedule_requested" ? "action" : "warning"
  });
  for (const admin of admins) {
    await insertNotification(db, {
      userId: admin.id,
      appointmentId,
      title: admin.id === req.user.id && req.user.role === "admin" ? "You updated a booking" : `Booking ${status}`,
      message:
        admin.id === req.user.id && req.user.role === "admin"
          ? `You set ${apptLabel} to ${status} (Ref: ${appt.booking_code}).`
          : `${apptLabel} was marked as ${status} (Ref: ${appt.booking_code}).`,
      type: "info"
    });
  }

  await sendAppointmentEmail({
    to: appt.student_email,
    subject: statusTitles[status],
    text: statusMessages[status]
  });

  const counselorEmailLine = `Student: ${appt.student_name} (${appt.student_email})\nBooking: ${appt.booking_code}\nNew status: ${status}`;
  if (appt.counselor_email) {
    await sendAppointmentEmail({
      to: appt.counselor_email,
      subject: `${statusTitles[status]} — ${appt.booking_code}`,
      text: `${counselorEmailLine}\n\n${statusMessages[status]}`
    });
  }

  res.json({ ok: true });
});

router.patch("/:id/outcome", requireRole("counselor", "admin"), async (req, res) => {
  const { outcome, note } = req.body || {};
  const allowed = new Set(["done", "referred", "no_show"]);
  if (!allowed.has(String(outcome))) {
    return res.status(400).json({ message: "Invalid outcome. Use done, referred, or no_show." });
  }
  const noteText = note == null ? null : String(note).trim().slice(0, 1000) || null;

  const db = getPool();
  const appointmentId = Number(req.params.id);
  const [rows] = await db.query(
    `SELECT a.*, s.full_name AS student_name, s.email AS student_email,
            c.full_name AS counselor_name
     FROM appointments a
     JOIN users s ON s.id = a.student_id
     JOIN users c ON c.id = a.counselor_id
     WHERE a.id = ?`,
    [appointmentId]
  );
  const appt = rows[0];
  if (!appt) return res.status(404).json({ message: "Appointment not found" });
  if (req.user.role === "counselor" && appt.counselor_id !== req.user.id) {
    return res.status(403).json({ message: "Cannot update other counselors' appointments" });
  }
  if (appt.status !== "accepted") {
    return res.status(400).json({ message: "Only accepted appointments can be marked done/referred/no-show." });
  }

  await db.query(
    "UPDATE appointments SET outcome = ?, outcome_at = NOW(), outcome_by = ?, outcome_note = ? WHERE id = ?",
    [outcome, req.user.id, noteText, appointmentId]
  );
  await db.query("INSERT INTO audit_logs (actor_id, action, meta) VALUES (?, ?, ?)", [
    req.user.id,
    "appointment_outcome_set",
    JSON.stringify({ appointmentId, outcome, bookingCode: appt.booking_code })
  ]);

  const labels = { done: "Session Completed", referred: "Referred", no_show: "Marked as No-Show" };
  const apptDateStr = String(appt.appointment_date).slice(0, 10);
  const apptTimeStr = String(appt.appointment_time).slice(0, 5);
  const messages = {
    done: `Your ${appt.service_type} session with ${appt.counselor_name} on ${apptDateStr} at ${apptTimeStr} is marked as completed (Ref: ${appt.booking_code}).`,
    referred: `Your ${appt.service_type} session on ${apptDateStr} at ${apptTimeStr} has been referred. The counselor will follow up if needed (Ref: ${appt.booking_code}).`,
    no_show: `Your ${appt.service_type} session on ${apptDateStr} at ${apptTimeStr} was marked as no-show. Please rebook if you still need help (Ref: ${appt.booking_code}).`
  };
  await insertNotification(db, {
    userId: appt.student_id,
    appointmentId,
    title: labels[outcome],
    message: messages[outcome],
    type: outcome === "done" ? "success" : outcome === "no_show" ? "warning" : "info"
  });

  if (appt.student_email) {
    await sendAppointmentEmail({
      to: appt.student_email,
      subject: `${labels[outcome]} (${appt.booking_code})`,
      text: messages[outcome] + (noteText ? `\n\nNote from counselor: ${noteText}` : "")
    });
  }

  res.json({ ok: true });
});

router.delete("/:id", requireRole("student"), async (req, res) => {
  const { cancellationReason } = req.body || {};
  const reason = String(cancellationReason || "").trim();
  if (reason.length < 5) {
    return res.status(400).json({ message: "Please explain why you are cancelling (at least 5 characters)." });
  }
  if (reason.length > 2000) {
    return res.status(400).json({ message: "Cancellation reason is too long (max 2000 characters)." });
  }

  const db = getPool();
  const appointmentId = Number(req.params.id);
  const [rows] = await db.query(
    `SELECT a.*, s.email AS student_email, s.full_name AS student_name,
            c.email AS counselor_email, c.full_name AS counselor_name
     FROM appointments a
     JOIN users s ON s.id = a.student_id
     JOIN users c ON c.id = a.counselor_id
     WHERE a.id = ?`,
    [appointmentId]
  );
  const appt = rows[0];
  if (!appt) return res.status(404).json({ message: "Appointment not found" });
  if (appt.student_id !== req.user.id) return res.status(403).json({ message: "Cannot cancel other users' bookings" });
  if (["cancelled", "declined"].includes(appt.status)) {
    return res.status(400).json({ message: "This appointment is already closed." });
  }

  await db.query(
    "UPDATE appointments SET status = 'cancelled', student_cancellation_reason = ? WHERE id = ?",
    [reason, appointmentId]
  );
  await db.query("INSERT INTO audit_logs (actor_id, action, meta) VALUES (?, ?, ?)", [
    req.user.id,
    "appointment_cancelled_by_student",
    JSON.stringify({ appointmentId, reasonSnippet: reason.slice(0, 200) })
  ]);

  const reasonLine = `Reason: ${reason}`;
  const apptDateStr = String(appt.appointment_date).slice(0, 10);
  const apptTimeStr = String(appt.appointment_time).slice(0, 5);
  const apptLabel = `${appt.service_type} session on ${apptDateStr} at ${apptTimeStr}`;
  await db.query(
    `INSERT INTO notifications (user_id, appointment_id, title, message, type)
     VALUES (?, ?, ?, ?, ?)`,
    [
      req.user.id,
      appointmentId,
      "Booking Cancelled",
      `You cancelled your ${apptLabel} (Ref: ${appt.booking_code}). ${reasonLine}`,
      "warning"
    ]
  );
  await insertNotification(db, {
    userId: appt.counselor_id,
    appointmentId,
    title: "Booking Cancelled",
    message: `${appt.student_name} cancelled the ${apptLabel} (Ref: ${appt.booking_code}). ${reasonLine}`,
    type: "warning"
  });
  const admins = await getAdminUsers(db);
  for (const admin of admins) {
    await insertNotification(db, {
      userId: admin.id,
      appointmentId,
      title: "Booking Cancelled",
      message: `${appt.student_name} cancelled the ${apptLabel} (Ref: ${appt.booking_code}). ${reasonLine}`,
      type: "warning"
    });
  }

  await sendAppointmentEmail({
    to: appt.student_email,
    subject: `Booking cancelled (${appt.booking_code})`,
    text: `Your appointment ${appt.booking_code} has been cancelled.\n\n${reasonLine}`
  });
  if (appt.counselor_email) {
    await sendAppointmentEmail({
      to: appt.counselor_email,
      subject: `Student cancelled ${appt.booking_code}`,
      text: `${appt.student_name} cancelled appointment ${appt.booking_code}.\n\n${reasonLine}`
    });
  }
  for (const admin of admins) {
    if (admin.email) {
      await sendAppointmentEmail({
        to: admin.email,
        subject: `Student cancelled ${appt.booking_code}`,
        text: `${appt.student_name} cancelled appointment ${appt.booking_code}.\n\n${reasonLine}`
      });
    }
  }

  res.json({ ok: true });
});

module.exports = router;
