/**
 * Session counts = appointments with status "accepted" (approved counseling sessions).
 */

function buildDayWindowSeries(dayRows, startDateStr, days = 30) {
  const map = {};
  for (const r of dayRows) {
    const key = String(r.d).slice(0, 10);
    map[key] = Number(r.cnt);
  }
  const start = startDateStr ? new Date(`${startDateStr}T00:00:00`) : new Date();
  if (Number.isNaN(start.getTime())) start.setTime(Date.now());
  if (!startDateStr) start.setDate(start.getDate() - (days - 1));
  start.setHours(12, 0, 0, 0);
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push({
      date: iso,
      label: d.toLocaleDateString("en-PH", { month: "short", day: "numeric" }),
      sessions: map[iso] || 0
    });
  }
  return out;
}

function buildMonthWindowSeries(monthRows, startMonthStr, months = 12) {
  const map = {};
  for (const r of monthRows) {
    map[r.ym] = Number(r.cnt);
  }
  let start;
  if (startMonthStr && /^\d{4}-\d{2}$/.test(startMonthStr)) {
    const [yy, mm] = startMonthStr.split("-").map(Number);
    start = new Date(yy, mm - 1, 1);
  } else {
    const now = new Date();
    start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  }
  const out = [];
  for (let i = 0; i < months; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    out.push({
      yearMonth: ym,
      label: d.toLocaleString("en-PH", { month: "short", year: "numeric" }),
      sessions: map[ym] || 0
    });
  }
  return out;
}

// kept for backward compatibility
function buildLast30DaysSeries(dayRows) {
  return buildDayWindowSeries(dayRows, null, 30);
}

function buildLast12MonthsSeries(monthRows) {
  return buildMonthWindowSeries(monthRows, null, 12);
}

async function getCounselorSessionAnalytics(db, counselorId) {
  const id = Number(counselorId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const [[weekRow]] = await db.query(
    `SELECT COUNT(*) AS c FROM appointments
     WHERE counselor_id = ? AND status = 'accepted'
       AND YEARWEEK(appointment_date, 1) = YEARWEEK(CURDATE(), 1)`,
    [id]
  );
  const [[monthRow]] = await db.query(
    `SELECT COUNT(*) AS c FROM appointments
     WHERE counselor_id = ? AND status = 'accepted'
       AND YEAR(appointment_date) = YEAR(CURDATE())
       AND MONTH(appointment_date) = MONTH(CURDATE())`,
    [id]
  );
  const [[yearRow]] = await db.query(
    `SELECT COUNT(*) AS c FROM appointments
     WHERE counselor_id = ? AND status = 'accepted'
       AND YEAR(appointment_date) = YEAR(CURDATE())`,
    [id]
  );

  const [dayRows] = await db.query(
    `SELECT DATE_FORMAT(appointment_date, '%Y-%m-%d') AS d, COUNT(*) AS cnt
     FROM appointments
     WHERE counselor_id = ? AND status = 'accepted'
       AND appointment_date >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
     GROUP BY DATE_FORMAT(appointment_date, '%Y-%m-%d')
     ORDER BY d ASC`,
    [id]
  );

  const [monthRows] = await db.query(
    `SELECT DATE_FORMAT(appointment_date, '%Y-%m') AS ym, COUNT(*) AS cnt
     FROM appointments
     WHERE counselor_id = ? AND status = 'accepted'
       AND appointment_date >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 11 MONTH)
     GROUP BY ym
     ORDER BY ym ASC`,
    [id]
  );

  const chart30Days = buildLast30DaysSeries(dayRows);
  const chart12Months = buildLast12MonthsSeries(monthRows);

  const w = Number(weekRow.c);
  const m = Number(monthRow.c);
  const y = Number(yearRow.c);

  const breakdown = await getOutcomeBreakdown(db, { counselorIds: [id] });

  return {
    counselorId: id,
    weekly: w,
    monthly: m,
    yearly: y,
    sessionsWeekly: w,
    sessionsMonthly: m,
    sessionsYearly: y,
    chart30Days,
    chart12Months,
    outcomeBreakdown: breakdown
  };
}

/**
 * Aggregate appointment outcome metrics across one or many counselors,
 * with optional service/year/college filters and date range.
 *
 * filters:
 *   counselorIds: number[] (optional — empty/missing means all counselors)
 *   serviceType: string
 *   yearLevel: string
 *   college: string
 *   from: 'YYYY-MM-DD'
 *   to: 'YYYY-MM-DD'
 */
async function getOutcomeBreakdown(db, filters = {}) {
  const where = ["1=1"];
  const params = [];
  if (Array.isArray(filters.counselorIds) && filters.counselorIds.length) {
    where.push(`a.counselor_id IN (${filters.counselorIds.map(() => "?").join(",")})`);
    params.push(...filters.counselorIds);
  }
  if (filters.serviceType) {
    where.push("a.service_type = ?");
    params.push(filters.serviceType);
  }
  if (filters.yearLevel) {
    where.push("a.year_level = ?");
    params.push(filters.yearLevel);
  }
  if (filters.college) {
    where.push("a.college = ?");
    params.push(filters.college);
  }
  if (filters.from) {
    where.push("a.appointment_date >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    where.push("a.appointment_date <= ?");
    params.push(filters.to);
  }
  const whereSql = where.join(" AND ");

  const [[rowTotals]] = await db.query(
    `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN a.status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN a.status = 'declined' THEN 1 ELSE 0 END) AS declined,
        SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelledByStudent,
        SUM(CASE WHEN a.outcome = 'done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN a.outcome = 'referred' THEN 1 ELSE 0 END) AS referred,
        SUM(CASE WHEN a.outcome = 'no_show' THEN 1 ELSE 0 END) AS noShow
     FROM appointments a
     WHERE ${whereSql}`,
    params
  );

  // Day-window range
  const dayStart = (filters.daysFromDate && /^\d{4}-\d{2}-\d{2}$/.test(filters.daysFromDate))
    ? filters.daysFromDate
    : null;
  let dayParams;
  let daySql;
  if (dayStart) {
    daySql = `SELECT DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS d, COUNT(*) AS cnt
              FROM appointments a
              WHERE ${whereSql}
                AND a.appointment_date >= ?
                AND a.appointment_date < DATE_ADD(?, INTERVAL 30 DAY)
              GROUP BY d ORDER BY d ASC`;
    dayParams = [...params, dayStart, dayStart];
  } else {
    daySql = `SELECT DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS d, COUNT(*) AS cnt
              FROM appointments a
              WHERE ${whereSql}
                AND a.appointment_date >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
              GROUP BY d ORDER BY d ASC`;
    dayParams = [...params];
  }
  const [byDay] = await db.query(daySql, dayParams);

  // Month-window range
  const monthStart = (filters.monthsFromMonth && /^\d{4}-\d{2}$/.test(filters.monthsFromMonth))
    ? filters.monthsFromMonth
    : null;
  let monthParams;
  let monthSql;
  if (monthStart) {
    const monthStartDate = `${monthStart}-01`;
    monthSql = `SELECT DATE_FORMAT(a.appointment_date, '%Y-%m') AS ym, COUNT(*) AS cnt
                FROM appointments a
                WHERE ${whereSql}
                  AND a.appointment_date >= ?
                  AND a.appointment_date < DATE_ADD(?, INTERVAL 12 MONTH)
                GROUP BY ym ORDER BY ym ASC`;
    monthParams = [...params, monthStartDate, monthStartDate];
  } else {
    monthSql = `SELECT DATE_FORMAT(a.appointment_date, '%Y-%m') AS ym, COUNT(*) AS cnt
                FROM appointments a
                WHERE ${whereSql}
                  AND a.appointment_date >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 11 MONTH)
                GROUP BY ym ORDER BY ym ASC`;
    monthParams = [...params];
  }
  const [byMonth] = await db.query(monthSql, monthParams);

  return {
    totals: {
      total: Number(rowTotals?.total || 0),
      pending: Number(rowTotals?.pending || 0),
      accepted: Number(rowTotals?.accepted || 0),
      declined: Number(rowTotals?.declined || 0),
      cancelledByStudent: Number(rowTotals?.cancelledByStudent || 0),
      done: Number(rowTotals?.done || 0),
      referred: Number(rowTotals?.referred || 0),
      noShow: Number(rowTotals?.noShow || 0)
    },
    chart30Days: buildDayWindowSeries(byDay, dayStart, 30),
    chart12Months: buildMonthWindowSeries(byMonth, monthStart, 12),
    chartDayStart: dayStart,
    chartMonthStart: monthStart
  };
}

module.exports = { getCounselorSessionAnalytics, getOutcomeBreakdown };
