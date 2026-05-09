const express = require("express");
const { getPool } = require("../config/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getCounselorSessionAnalytics } = require("../services/counselorAnalytics");

const router = express.Router();
router.use(requireAuth);

// Counselor analytics — approved sessions (accepted) + time series for charts
router.get("/analytics", requireRole("counselor"), async (req, res) => {
  const db = getPool();
  const data = await getCounselorSessionAnalytics(db, req.user.id);
  res.json(data);
});

router.get("/calendar", requireRole("student", "counselor", "admin"), async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  let counselorId = req.user.id;
  if (req.user.role === "admin" || req.user.role === "student") {
    counselorId = Number(req.query.counselorId) || null;
    if (!counselorId) return res.status(400).json({ message: "counselorId is required." });
  }
  const db = getPool();
  const [appointments] = await db.query(
    `SELECT id, appointment_date, appointment_time, status, service_type
     FROM appointments
     WHERE counselor_id = ? AND YEAR(appointment_date) = ?
       AND status IN ('pending','accepted','reschedule_requested')
     ORDER BY appointment_date, appointment_time`,
    [counselorId, year]
  );
  const [unavailable] = await db.query(
    `SELECT id, unavailable_date, start_time, end_time, message
     FROM counselor_unavailabilities
     WHERE counselor_id = ? AND YEAR(unavailable_date) = ?
     ORDER BY unavailable_date, start_time IS NULL DESC, start_time`,
    [counselorId, year]
  );
  res.json({ year, counselorId, appointments, unavailable });
});

router.get("/availability", requireRole("counselor"), async (req, res) => {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT id, unavailable_date, start_time, end_time, message
     FROM counselor_unavailabilities
     WHERE counselor_id = ?
     ORDER BY unavailable_date DESC, start_time IS NULL DESC, start_time`,
    [req.user.id]
  );
  res.json(rows);
});

router.get("/availability/:counselorId", requireRole("student", "admin", "counselor"), async (req, res) => {
  const counselorId = Number(req.params.counselorId);
  const db = getPool();
  const [rows] = await db.query(
    `SELECT id, unavailable_date, start_time, end_time, message
     FROM counselor_unavailabilities
     WHERE counselor_id = ?
     ORDER BY unavailable_date DESC, start_time IS NULL DESC, start_time`,
    [counselorId]
  );
  res.json(rows);
});

function normalizeTime(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(s)) return null;
  return s.length === 5 ? `${s}:00` : s;
}

router.post("/availability", requireRole("counselor"), async (req, res) => {
  const { unavailable_date, message, start_time, end_time } = req.body;
  if (!unavailable_date) return res.status(400).json({ message: "unavailable_date is required" });

  const startT = normalizeTime(start_time);
  const endT = normalizeTime(end_time);
  if ((start_time && !startT) || (end_time && !endT)) {
    return res.status(400).json({ message: "Invalid time format. Use HH:MM (24-hour)." });
  }
  if (startT && endT && startT >= endT) {
    return res.status(400).json({ message: "End time must be after start time." });
  }

  const db = getPool();
  if (!startT && !endT) {
    const [conflicts] = await db.query(
      `SELECT id FROM appointments
       WHERE counselor_id = ? AND appointment_date = ? AND status = 'accepted'
       LIMIT 1`,
      [req.user.id, unavailable_date]
    );
    if (conflicts.length > 0) {
      return res.status(409).json({ message: "Cannot set unavailable date with confirmed appointments. Cancel/reschedule first." });
    }
  } else {
    const [conflicts] = await db.query(
      `SELECT id FROM appointments
       WHERE counselor_id = ? AND appointment_date = ? AND status = 'accepted'
         AND appointment_time >= ? AND appointment_time < ?
       LIMIT 1`,
      [req.user.id, unavailable_date, startT || "00:00:00", endT || "23:59:59"]
    );
    if (conflicts.length > 0) {
      return res.status(409).json({ message: "Cannot block this time slot — accepted appointment exists. Cancel/reschedule first." });
    }
  }

  try {
    const [result] = await db.query(
      `INSERT INTO counselor_unavailabilities (counselor_id, unavailable_date, start_time, end_time, message)
       VALUES (?, ?, ?, ?, ?)`,
      [req.user.id, unavailable_date, startT, endT, message || null]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "An identical entry already exists." });
    return res.status(500).json({ message: err.message });
  }
});

router.delete("/availability/:id", requireRole("counselor"), async (req, res) => {
  const availabilityId = Number(req.params.id);
  const db = getPool();
  const [rows] = await db.query(
    "SELECT id, counselor_id FROM counselor_unavailabilities WHERE id = ?",
    [availabilityId]
  );
  if (!rows[0]) return res.status(404).json({ message: "Entry not found" });
  if (rows[0].counselor_id !== req.user.id) return res.status(403).json({ message: "Not authorized" });

  await db.query("DELETE FROM counselor_unavailabilities WHERE id = ?", [availabilityId]);
  res.json({ ok: true });
});

module.exports = router;

