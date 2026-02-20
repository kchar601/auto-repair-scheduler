/**
 * index.js (Express + MySQL)
 *
 * Endpoints included:
 *  - GET  /schedule/month?year=YYYY&month=M
 *  - GET  /schedule/day?date=YYYY-MM-DD
 *  - GET  /appointments/:id
 *  - POST /appointments
 *  - PUT  /appointments/:id
 *  - DELETE /appointments/:id
 *
 * Notes:
 *  - Uses scheduleDay row locking (SELECT ... FOR UPDATE) to prevent double-booking races.
 *  - Capacity uses (3->16, 2->10, 1->6) based on mechanics working that date.
 *    FULL off-days reduce working mechanic count.
 *    PART off-days subtract jobsDropped from capacity.
 */

const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const path = require("path");
const dotenv = require("dotenv");

// Always load backend .env regardless of the current working directory.
dotenv.config({ path: path.resolve(__dirname, ".env") });
const app = express();
app.use(cors());
app.use(express.json());

const dbPass = process.env.MYSQLPASS ?? process.env.MYSQL_PASSWORD ?? process.env.DB_PASSWORD;

if (!dbPass) {
  console.error("Missing MySQL password. Set MYSQLPASS in react-sql-backend/.env.");
  process.exit(1);
}
// -----------------------
// MySQL Connection (promise)
// -----------------------
const db = mysql
  .createConnection({
    host: process.env.MYSQLHOST || "localhost",
    user: process.env.MYSQLUSER || "root",
    password: dbPass,
    database: process.env.MYSQLDATABASE || "schedule",
  })
  .promise();

(async function testDb() {
  try {
    await db.query("SELECT 1");
    console.log("Connected to MySQL database.");
  } catch (err) {
    console.error("Database connection failed:", err);
    process.exit(1);
  }
})();

// -----------------------
// Helpers
// -----------------------
function isValidDateString(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isSunday(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay() === 0;
}

function baseCapacityByMechanics(n) {
  if (n >= 3) return 16;
  if (n === 2) return 10;
  if (n === 1) return 6;
  return 0;
}

function getWaitLimit(dateStr) {
  // Sunday=0, Saturday=6 in JS Date.getDay()
  const d = new Date(dateStr + "T00:00:00");
  if (d.getDay() === 0) return 0;
  return d.getDay() === 6 ? 2 : 3;
}

function toMonthRange(year, month1to12) {
  const y = Number(year);
  const m = Number(month1to12);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error("Invalid year/month");
  }
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 0)); // last day of month
  const pad = (n) => String(n).padStart(2, "0");
  const fromStr = `${from.getUTCFullYear()}-${pad(from.getUTCMonth() + 1)}-${pad(from.getUTCDate())}`;
  const toStr = `${to.getUTCFullYear()}-${pad(to.getUTCMonth() + 1)}-${pad(to.getUTCDate())}`;
  return { fromStr, toStr };
}

function datesBetweenInclusive(fromStr, toStr) {
  const out = [];
  const start = new Date(fromStr + "T00:00:00");
  const end = new Date(toStr + "T00:00:00");
  for (let d = start; d <= end; d = new Date(d.getTime() + 86400000)) {
    const pad = (n) => String(n).padStart(2, "0");
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }
  return out;
}

function normalizeTimeMaybe(t) {
  // Accept "09:00" or "09:00:00" or null/undefined
  if (t == null) return null;
  if (typeof t !== "string") return null;
  if (/^\d{2}:\d{2}$/.test(t)) return t + ":00";
  if (/^\d{2}:\d{2}:\d{2}$/.test(t)) return t;
  return null;
}

function validateAppointmentPayload(body, { partial = false } = {}) {
  // For POST: partial=false (require required fields)
  // For PUT:  partial=true  (allow missing; but if present, validate)
  const errors = [];

  const requiredIfNotPartial = (key, checkFn, msg) => {
    if (!partial) {
      if (!checkFn(body[key])) errors.push(msg);
    } else {
      if (body[key] !== undefined && !checkFn(body[key])) errors.push(msg);
    }
  };

  const optionalIfPresent = (key, checkFn, msg) => {
    if (body[key] !== undefined && !checkFn(body[key])) errors.push(msg);
  };

  requiredIfNotPartial(
    "scheduledDate",
    (v) => isValidDateString(v),
    "scheduledDate must be YYYY-MM-DD",
  );
  requiredIfNotPartial(
    "lname",
    (v) => typeof v === "string" && v.trim().length > 0,
    "lname is required",
  );
  requiredIfNotPartial(
    "vehicle",
    (v) => typeof v === "string" && v.trim().length > 0,
    "vehicle is required",
  );
  requiredIfNotPartial(
    "phone",
    (v) => typeof v === "string" && v.trim().length > 0,
    "phone is required",
  );
  requiredIfNotPartial(
    "services",
    (v) => typeof v === "string" && v.trim().length > 0,
    "services is required",
  );

  optionalIfPresent(
    "kind",
    (v) => ["DROPOFF", "WAIT", "DUE_BY"].includes(v),
    "kind must be DROPOFF | WAIT | DUE_BY",
  );

  optionalIfPresent(
    "priorityTime",
    (v) => normalizeTimeMaybe(v) !== null,
    "priorityTime must be HH:MM or HH:MM:SS",
  );

  optionalIfPresent(
    "isFirstJob",
    (v) => typeof v === "boolean",
    "isFirstJob must be boolean",
  );

  optionalIfPresent(
    "slotsRequired",
    (v) => Number.isInteger(v) && v >= 1,
    "slotsRequired must be an integer >= 1",
  );

  optionalIfPresent(
    "isCapacityOverride",
    (v) => typeof v === "boolean",
    "isCapacityOverride must be boolean",
  );
  optionalIfPresent(
    "isWaitLimitOverride",
    (v) => typeof v === "boolean",
    "isWaitLimitOverride must be boolean",
  );

  // Enforce kind/priorityTime rule if both are known
  // - DROPOFF => priorityTime must be null
  // - WAIT/DUE_BY => priorityTime must be non-null
  const kind = body.kind ?? null;
  const pt = body.priorityTime ?? undefined; // could be missing in partial mode

  if (!partial) {
    const effKind = kind ?? "DROPOFF";
    const effPT = normalizeTimeMaybe(body.priorityTime);
    if (effKind === "DROPOFF" && effPT !== null)
      errors.push("priorityTime must be null for DROPOFF");
    if (["WAIT", "DUE_BY"].includes(effKind) && effPT === null)
      errors.push("priorityTime is required for WAIT/DUE_BY");
  } else {
    // In partial update, only validate consistency if both provided
    if (kind && pt !== undefined) {
      const effPT = normalizeTimeMaybe(pt);
      if (kind === "DROPOFF" && effPT !== null)
        errors.push("priorityTime must be null for DROPOFF");
      if (["WAIT", "DUE_BY"].includes(kind) && effPT === null)
        errors.push("priorityTime is required for WAIT/DUE_BY");
    }
  }

  return errors;
}

// Capacity calculation for a date
async function getCapacityMeta(dateStr, conn /* db or connection */) {
  if (isSunday(dateStr)) {
    return {
      totalMechanics: 0,
      fullOffCount: 0,
      workingMechanics: 0,
      baseCapacity: 0,
      partialJobsDropped: 0,
      capacitySlots: 0,
    };
  }

  const [[counts]] = await conn.query(
    `
    SELECT
      (SELECT COUNT(*) FROM mechanic) AS totalMechanics,
      (SELECT COUNT(*) FROM mechanicOffDay WHERE date = ? AND leaveType = 'FULL') AS fullOffCount
    `,
    [dateStr],
  );

  const totalMechanics = Number(counts.totalMechanics || 0);
  const fullOffCount = Number(counts.fullOffCount || 0);
  const workingMechanics = Math.max(0, totalMechanics - fullOffCount);
  const baseCapacity = baseCapacityByMechanics(workingMechanics);

  const [[drops]] = await conn.query(
    `
    SELECT COALESCE(SUM(jobsDropped), 0) AS partialJobsDropped
    FROM mechanicOffDay
    WHERE date = ? AND leaveType = 'PART'
    `,
    [dateStr],
  );

  const partialJobsDropped = Number(drops.partialJobsDropped || 0);
  const capacitySlots = Math.max(0, baseCapacity - partialJobsDropped);

  return {
    totalMechanics,
    fullOffCount,
    workingMechanics,
    baseCapacity,
    partialJobsDropped,
    capacitySlots,
  };
}

// Day summary (counts and remaining)
async function getDaySummary(dateStr, conn) {
  const cap = await getCapacityMeta(dateStr, conn);
  const waitLimit = getWaitLimit(dateStr);

  const [[agg]] = await conn.query(
    `
    SELECT
      COALESCE(SUM(CASE WHEN isCapacityOverride = 0 THEN slotsRequired ELSE 0 END), 0) AS usedSlots,
      COALESCE(SUM(CASE WHEN isCapacityOverride = 1 THEN slotsRequired ELSE 0 END), 0) AS overbookedSlots,
      COALESCE(SUM(CASE WHEN kind IN ('WAIT', 'DUE_BY') AND isWaitLimitOverride = 0 THEN 1 ELSE 0 END), 0) AS waitUsed,
      COALESCE(SUM(CASE WHEN kind IN ('WAIT', 'DUE_BY') AND isWaitLimitOverride = 1 THEN 1 ELSE 0 END), 0) AS waitOverrides
    FROM appointments
    WHERE scheduledDate = ?
    `,
    [dateStr],
  );

  const usedSlots = Number(agg.usedSlots || 0);
  const overbookedSlots = Number(agg.overbookedSlots || 0);
  const waitUsed = Number(agg.waitUsed || 0);
  const waitOverrides = Number(agg.waitOverrides || 0);

  return {
    date: dateStr,
    ...cap,
    usedSlots,
    remainingSlots: cap.capacitySlots - usedSlots,
    overbookedSlots,
    waitLimit,
    waitUsed,
    waitRemaining: waitLimit - waitUsed,
    waitOverrides,
  };
}

// Ensure a scheduleDay row exists (for locking)
async function ensureScheduleDay(dateStr, conn) {
  await conn.query(`INSERT IGNORE INTO scheduleDay (date) VALUES (?)`, [
    dateStr,
  ]);
}

// Lock a date row (prevents two inserts racing for same day)
async function lockScheduleDay(dateStr, conn) {
  await ensureScheduleDay(dateStr, conn);
  await conn.query(`SELECT date FROM scheduleDay WHERE date = ? FOR UPDATE`, [
    dateStr,
  ]);
}

// Fetch appointment by id
async function getAppointmentById(id, conn) {
  const [[row]] = await conn.query(`SELECT * FROM appointments WHERE id = ?`, [
    id,
  ]);
  return row || null;
}

// -----------------------
// Schedule endpoints
// -----------------------

// Monthly summary for React-Calendar tiles
// GET /schedule/month?year=2026&month=2
app.get("/schedule/month", async (req, res) => {
  try {
    const { year, month } = req.query;
    const { fromStr, toStr } = toMonthRange(year, month);
    const days = datesBetweenInclusive(fromStr, toStr);

    // Basic approach: compute per-day summaries in parallel (fine for small N like 28-31)
    // You can optimize later to 1 grouped SQL query if needed.
    const summaries = [];
    for (const dateStr of days) {
      const s = await getDaySummary(dateStr, db);
      summaries.push({
        date: s.date,
        capacitySlots: s.capacitySlots,
        usedSlots: s.usedSlots,
        remainingSlots: s.remainingSlots,
        waitLimit: s.waitLimit,
        waitUsed: s.waitUsed,
        waitRemaining: s.waitRemaining,
        overbookedSlots: s.overbookedSlots,
        workingMechanics: s.workingMechanics,
        partialJobsDropped: s.partialJobsDropped,
      });
    }

    res.json({
      range: { from: fromStr, to: toStr },
      days: summaries,
    });
  } catch (err) {
    res.status(400).json({ error: "BAD_REQUEST", message: err.message });
  }
});

// Day summary + list of appointments
// GET /schedule/day?date=YYYY-MM-DD
app.get("/schedule/day", async (req, res) => {
  try {
    const { date } = req.query;
    if (!isValidDateString(date)) {
      return res
        .status(400)
        .json({ error: "BAD_REQUEST", message: "date must be YYYY-MM-DD" });
    }

    const summary = await getDaySummary(date, db);
    const [rows] = await db.query(
      `SELECT * FROM appointments WHERE scheduledDate = ? ORDER BY (isFirstJob = 1) DESC, priorityTime IS NULL, priorityTime ASC, id ASC`,
      [date],
    );

    res.json({ date, summary, appointments: rows });
  } catch (err) {
    res.status(500).json({ error: "SERVER_ERROR", message: err.message });
  }
});

// -----------------------
// Appointment CRUD
// -----------------------

// GET /appointments/:id
app.get("/appointments/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id))
      return res
        .status(400)
        .json({ error: "BAD_REQUEST", message: "Invalid id" });

    const appt = await getAppointmentById(id, db);
    if (!appt)
      return res
        .status(404)
        .json({ error: "NOT_FOUND", message: "Appointment not found" });

    res.json({ appointment: appt });
  } catch (err) {
    res.status(500).json({ error: "SERVER_ERROR", message: err.message });
  }
});

// POST /appointments
app.post("/appointments", async (req, res) => {
  const errors = validateAppointmentPayload(req.body, { partial: false });
  if (errors.length) {
    return res.status(400).json({ error: "VALIDATION_ERROR", details: errors });
  }

  // Normalize fields
  const payload = {
    scheduledDate: req.body.scheduledDate,
    lname: req.body.lname.trim(),
    vehicle: req.body.vehicle.trim(),
    phone: String(req.body.phone).trim(),
    services: req.body.services.trim(),
    kind: req.body.kind || "DROPOFF",
    priorityTime: normalizeTimeMaybe(req.body.priorityTime),
    isFirstJob: Boolean(req.body.isFirstJob),
    slotsRequired: Number(req.body.slotsRequired ?? 1),
    isCapacityOverride: Boolean(req.body.isCapacityOverride),
    isWaitLimitOverride: Boolean(req.body.isWaitLimitOverride),
  };

  if (isSunday(payload.scheduledDate)) {
    return res.status(409).json({
      error: "SHOP_CLOSED",
      message: "No appointments can be scheduled on Sundays.",
      date: payload.scheduledDate,
    });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    // Lock the day row so two schedulers can't both "pass" capacity checks at once
    await lockScheduleDay(payload.scheduledDate, conn);

    // Recompute summary inside the transaction
    const summary = await getDaySummary(payload.scheduledDate, conn);

    // Capacity rule
    if (!payload.isCapacityOverride) {
      if (summary.usedSlots + payload.slotsRequired > summary.capacitySlots) {
        await conn.rollback();
        return res.status(409).json({
          error: "DAY_CAPACITY_FULL",
          message: "That day is full (capacity).",
          date: payload.scheduledDate,
          capacitySlots: summary.capacitySlots,
          usedSlots: summary.usedSlots,
          attemptedSlots: payload.slotsRequired,
          remainingSlots: summary.remainingSlots,
        });
      }
    }

    // Wait limit rule
    if (["WAIT", "DUE_BY"].includes(payload.kind) && !payload.isWaitLimitOverride) {
      if (summary.waitUsed + 1 > summary.waitLimit) {
        await conn.rollback();
        return res.status(409).json({
          error: "WAIT_LIMIT_REACHED",
          message: "Wait/Due-by appointments are full for that day.",
          date: payload.scheduledDate,
          waitLimit: summary.waitLimit,
          waitUsed: summary.waitUsed,
          waitRemaining: summary.waitRemaining,
        });
      }
    }

    // Insert
    const [result] = await conn.query(
      `
      INSERT INTO appointments
      (scheduledDate, lname, vehicle, phone, services, kind, priorityTime,
       isFirstJob, slotsRequired, isCapacityOverride, isWaitLimitOverride)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        payload.scheduledDate,
        payload.lname,
        payload.vehicle,
        payload.phone,
        payload.services,
        payload.kind,
        payload.priorityTime,
        payload.isFirstJob ? 1 : 0,
        payload.slotsRequired,
        payload.isCapacityOverride ? 1 : 0,
        payload.isWaitLimitOverride ? 1 : 0,
      ],
    );

    const insertedId = result.insertId;

    // New summary after insert
    const newSummary = await getDaySummary(payload.scheduledDate, conn);

    await conn.commit();

    const appt = await getAppointmentById(insertedId, db);
    res.status(201).json({ appointment: appt, summary: newSummary });
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    res.status(500).json({ error: "SERVER_ERROR", message: err.message });
  } finally {
    conn.release();
  }
});

// PUT /appointments/:id
app.put("/appointments/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id))
    return res
      .status(400)
      .json({ error: "BAD_REQUEST", message: "Invalid id" });

  const errors = validateAppointmentPayload(req.body, { partial: true });
  if (errors.length) {
    return res.status(400).json({ error: "VALIDATION_ERROR", details: errors });
  }

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const existing = await getAppointmentById(id, conn);
    if (!existing) {
      await conn.rollback();
      return res
        .status(404)
        .json({ error: "NOT_FOUND", message: "Appointment not found" });
    }

    // Build updated record (merge existing + body)
    const updated = {
      scheduledDate: req.body.scheduledDate ?? existing.scheduledDate,
      lname: (req.body.lname ?? existing.lname).trim(),
      vehicle: (req.body.vehicle ?? existing.vehicle).trim(),
      phone: String(req.body.phone ?? existing.phone).trim(),
      services: (req.body.services ?? existing.services).trim(),
      kind: req.body.kind ?? existing.kind,
      priorityTime:
        req.body.priorityTime === undefined
          ? existing.priorityTime
          : normalizeTimeMaybe(req.body.priorityTime),
      isFirstJob:
        req.body.isFirstJob === undefined
          ? Boolean(existing.isFirstJob)
          : Boolean(req.body.isFirstJob),
      slotsRequired:
        req.body.slotsRequired === undefined
          ? Number(existing.slotsRequired)
          : Number(req.body.slotsRequired),
      isCapacityOverride:
        req.body.isCapacityOverride === undefined
          ? Boolean(existing.isCapacityOverride)
          : Boolean(req.body.isCapacityOverride),
      isWaitLimitOverride:
        req.body.isWaitLimitOverride === undefined
          ? Boolean(existing.isWaitLimitOverride)
          : Boolean(req.body.isWaitLimitOverride),
    };

    // Re-validate kind/priorityTime consistency after merge
    const mergedErrors = validateAppointmentPayload(updated, {
      partial: false,
    });
    if (mergedErrors.length) {
      await conn.rollback();
      return res
        .status(400)
        .json({ error: "VALIDATION_ERROR", details: mergedErrors });
    }

    if (isSunday(updated.scheduledDate)) {
      await conn.rollback();
      return res.status(409).json({
        error: "SHOP_CLOSED",
        message: "No appointments can be scheduled on Sundays.",
        date: updated.scheduledDate,
      });
    }

    // Lock affected schedule days (old and new if moved)
    const oldDate = existing.scheduledDate;
    const newDate = updated.scheduledDate;

    // To avoid deadlocks, lock in sorted order
    const lockDates = [oldDate, newDate].filter(Boolean).sort();
    for (const d of lockDates) {
      await lockScheduleDay(d, conn);
    }

    // Capacity checks must consider "excluding this appointment" on that day.
    // Simplest: compute day summary with current data, then compute usedSlotsWithoutThis.
    // We'll compute day aggregates and subtract if the existing appointment was counted.

    // Helper to get day agg excluding a specific id (within txn)
    async function getDaySummaryExcludingId(dateStr, excludeId) {
      const cap = await getCapacityMeta(dateStr, conn);
      const waitLimit = getWaitLimit(dateStr);

      const [[agg]] = await conn.query(
        `
        SELECT
          COALESCE(SUM(CASE WHEN isCapacityOverride = 0 THEN slotsRequired ELSE 0 END), 0) AS usedSlots,
          COALESCE(SUM(CASE WHEN isCapacityOverride = 1 THEN slotsRequired ELSE 0 END), 0) AS overbookedSlots,
          COALESCE(SUM(CASE WHEN kind IN ('WAIT', 'DUE_BY') AND isWaitLimitOverride = 0 THEN 1 ELSE 0 END), 0) AS waitUsed
        FROM appointments
        WHERE scheduledDate = ? AND id <> ?
        `,
        [dateStr, excludeId],
      );

      const usedSlots = Number(agg.usedSlots || 0);
      const overbookedSlots = Number(agg.overbookedSlots || 0);
      const waitUsed = Number(agg.waitUsed || 0);

      return {
        date: dateStr,
        ...cap,
        usedSlots,
        remainingSlots: cap.capacitySlots - usedSlots,
        overbookedSlots,
        waitLimit,
        waitUsed,
        waitRemaining: waitLimit - waitUsed,
      };
    }

    const summaryNewDate = await getDaySummaryExcludingId(newDate, id);

    // Capacity rule on new date
    if (!updated.isCapacityOverride) {
      if (
        summaryNewDate.usedSlots + updated.slotsRequired >
        summaryNewDate.capacitySlots
      ) {
        await conn.rollback();
        return res.status(409).json({
          error: "DAY_CAPACITY_FULL",
          message: "That day is full (capacity).",
          date: newDate,
          capacitySlots: summaryNewDate.capacitySlots,
          usedSlots: summaryNewDate.usedSlots,
          attemptedSlots: updated.slotsRequired,
          remainingSlots: summaryNewDate.remainingSlots,
        });
      }
    }

    // Wait rule on new date
    if (["WAIT", "DUE_BY"].includes(updated.kind) && !updated.isWaitLimitOverride) {
      if (summaryNewDate.waitUsed + 1 > summaryNewDate.waitLimit) {
        await conn.rollback();
        return res.status(409).json({
          error: "WAIT_LIMIT_REACHED",
          message: "Wait/Due-by appointments are full for that day.",
          date: newDate,
          waitLimit: summaryNewDate.waitLimit,
          waitUsed: summaryNewDate.waitUsed,
          waitRemaining: summaryNewDate.waitRemaining,
        });
      }
    }

    // Update row
    await conn.query(
      `
      UPDATE appointments
      SET scheduledDate = ?,
          lname = ?,
          vehicle = ?,
          phone = ?,
          services = ?,
          kind = ?,
          priorityTime = ?,
          isFirstJob = ?,
          slotsRequired = ?,
          isCapacityOverride = ?,
          isWaitLimitOverride = ?
      WHERE id = ?
      `,
      [
        updated.scheduledDate,
        updated.lname,
        updated.vehicle,
        updated.phone,
        updated.services,
        updated.kind,
        updated.priorityTime,
        updated.isFirstJob ? 1 : 0,
        updated.slotsRequired,
        updated.isCapacityOverride ? 1 : 0,
        updated.isWaitLimitOverride ? 1 : 0,
        id,
      ],
    );

    // Summaries after update (for UI refresh)
    const summaryAfter = await getDaySummary(updated.scheduledDate, conn);

    await conn.commit();

    const appt = await getAppointmentById(id, db);
    res.json({ appointment: appt, summary: summaryAfter });
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    res.status(500).json({ error: "SERVER_ERROR", message: err.message });
  } finally {
    conn.release();
  }
});

// DELETE /appointments/:id
app.delete("/appointments/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id))
    return res
      .status(400)
      .json({ error: "BAD_REQUEST", message: "Invalid id" });

  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const existing = await getAppointmentById(id, conn);
    if (!existing) {
      await conn.rollback();
      return res
        .status(404)
        .json({ error: "NOT_FOUND", message: "Appointment not found" });
    }

    const dateStr = existing.scheduledDate;

    await lockScheduleDay(dateStr, conn);

    await conn.query(`DELETE FROM appointments WHERE id = ?`, [id]);

    const summaryAfter = await getDaySummary(dateStr, conn);

    await conn.commit();

    res.json({ deleted: true, id, date: dateStr, summary: summaryAfter });
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    res.status(500).json({ error: "SERVER_ERROR", message: err.message });
  } finally {
    conn.release();
  }
});

// -----------------------
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

