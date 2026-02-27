/**
 * index.js (Express + MySQL)
 *
 * Endpoints included:
 *  - GET  /schedule/month?year=YYYY&month=M
 *  - GET  /schedule/day/mechanics?date=YYYY-MM-DD
 *  - PUT  /schedule/day/mechanics?date=YYYY-MM-DD
 *  - GET  /schedule/day?date=YYYY-MM-DD
 *  - GET  /appointments/:id
 *  - POST /appointments
 *  - PUT  /appointments/:id
 *  - DELETE /appointments/:id
 *  - GET  /realtime/schedule (SSE)
 *  - POST /appointment-locks
 *  - PUT  /appointment-locks/:token
 *  - DELETE /appointment-locks/:token
 *
 * Notes:
 *  - Uses scheduleDay row locking (SELECT ... FOR UPDATE) to prevent double-booking races.
 *  - Capacity uses (4->20, 3->16, 2->10, 1->6) based on mechanics working that date.
 *    FULL off-days reduce working mechanic count.
 *    PART off-days subtract jobsDropped from capacity.
 */

const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const path = require("path");
const dotenv = require("dotenv");
const crypto = require("crypto");
const https = require("https");
const fs = require("fs");

const options = {
  key: fs.readFileSync(
    path.resolve(__dirname, "certs/burnsschedule.local-key.pem"),
  ),
  cert: fs.readFileSync(
    path.resolve(__dirname, "certs/burnsschedule.local.pem"),
  ),
};

// Always load backend .env regardless of the current working directory.
dotenv.config({ path: path.resolve(__dirname, ".env") });
const app = express();
app.use(cors());
app.use(express.json());

const frontendDistPath = path.resolve(__dirname, "../react-sql-frontend/dist");
app.use(express.static(frontendDistPath));

const DRAFT_LOCK_TTL_SECONDS = Math.max(
  30,
  Math.min(900, Number(process.env.DRAFT_LOCK_TTL_SECONDS || 90)),
);
const SSE_KEEPALIVE_MS = 20000;
const realtimeClients = new Set();
const DEFAULT_OFF_MECHANIC_IDS = new Set(
  String(process.env.DEFAULT_OFF_MECHANIC_IDS || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0),
);
const DEFAULT_OFF_MECHANIC_NAMES = new Set(
  String(process.env.DEFAULT_OFF_MECHANIC_NAMES || "wes")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

const dbPass =
  process.env.MYSQLPASS ??
  process.env.MYSQL_PASSWORD ??
  process.env.DB_PASSWORD;

if (!dbPass) {
  console.error(
    "Missing MySQL password. Set MYSQLPASS in react-sql-backend/.env.",
  );
  process.exit(1);
}
// -----------------------
// MySQL Pool (promise)
// -----------------------
const db = mysql
  .createPool({
    host: process.env.MYSQLHOST || "localhost",
    user: process.env.MYSQLUSER || "root",
    password: dbPass,
    database: process.env.MYSQLDATABASE || "schedule",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  })
  .promise();

const APPOINTMENT_STATUSES = [
  "WAITING_FOR_DROPOFF",
  "QUEUED_FOR_TECHNICIAN",
  "IN_SERVICE",
  "READY_FOR_PICKUP",
];
const DEFAULT_APPOINTMENT_STATUS = "WAITING_FOR_DROPOFF";
const APPOINTMENT_KINDS = ["DROPOFF", "WAIT", "DUE_BY"];

function normalizeAppointmentStatus(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (!APPOINTMENT_STATUSES.includes(normalized)) return null;
  return normalized;
}

function normalizeAppointmentKind(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (!APPOINTMENT_KINDS.includes(normalized)) return null;
  return normalized;
}

async function ensureAppointmentStatusColumn() {
  const [rows] = await db.query(
    `
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'appointments'
      AND COLUMN_NAME = 'status'
    LIMIT 1
    `,
  );

  if (rows.length > 0) return;

  await db.query(
    `
    ALTER TABLE appointments
    ADD COLUMN status
      ENUM('WAITING_FOR_DROPOFF', 'QUEUED_FOR_TECHNICIAN', 'IN_SERVICE', 'READY_FOR_PICKUP')
      NOT NULL
      DEFAULT 'WAITING_FOR_DROPOFF'
      AFTER kind
    `,
  );
}

async function ensureAppointmentDraftLocksTable() {
  await db.query(
    `
    CREATE TABLE IF NOT EXISTS appointmentDraftLock (
      token VARCHAR(64) NOT NULL,
      scheduledDate DATE NOT NULL,
      kind ENUM('DROPOFF', 'WAIT', 'DUE_BY') NOT NULL DEFAULT 'DROPOFF',
      slotsRequired INT NOT NULL DEFAULT 1,
      isCapacityOverride TINYINT(1) NOT NULL DEFAULT 0,
      isWaitLimitOverride TINYINT(1) NOT NULL DEFAULT 0,
      expiresAt DATETIME NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (token),
      KEY idx_appointmentDraftLock_date_expiry (scheduledDate, expiresAt),
      KEY idx_appointmentDraftLock_expiry (expiresAt)
    ) ENGINE=InnoDB
    `,
  );
}

(async function initializeDb() {
  try {
    await db.query("SELECT 1");
    await ensureAppointmentStatusColumn();
    await ensureAppointmentDraftLocksTable();
    console.log("Connected to MySQL database.");
  } catch (err) {
    console.error("Database connection failed:", err);
    process.exit(1);
  }
})();

setInterval(() => {
  void sweepExpiredDraftLocksAndBroadcast();
}, 10000);

// -----------------------
// Helpers
// -----------------------
function isValidDateString(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function toDateOnlyString(value) {
  if (isValidDateString(value)) return value;

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      const year = parsed.getFullYear();
      const month = String(parsed.getMonth() + 1).padStart(2, "0");
      const day = String(parsed.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
  }

  return null;
}

function toIsoTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function createDraftLockToken() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return crypto.randomBytes(24).toString("hex");
}

function isSunday(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay() === 0;
}

function baseCapacityByMechanics(n) {
  if (n >= 4) return 20;
  if (n >= 3) return 16;
  if (n === 2) return 10;
  if (n === 1) return 6;
  return 0;
}

function normalizeMechanicNamePart(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isDefaultOffMechanicRow(row) {
  const mechanicId = Number(row?.id);
  if (
    Number.isInteger(mechanicId) &&
    DEFAULT_OFF_MECHANIC_IDS.has(mechanicId)
  ) {
    return true;
  }
  if (DEFAULT_OFF_MECHANIC_NAMES.size === 0) return false;

  const firstName = normalizeMechanicNamePart(row?.fname);
  const lastName = normalizeMechanicNamePart(row?.lname);
  const fullName = [firstName, lastName].filter(Boolean).join(" ");

  return (
    (firstName && DEFAULT_OFF_MECHANIC_NAMES.has(firstName)) ||
    (lastName && DEFAULT_OFF_MECHANIC_NAMES.has(lastName)) ||
    (fullName && DEFAULT_OFF_MECHANIC_NAMES.has(fullName))
  );
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
  const [fromY, fromM, fromD] = fromStr.split("-").map(Number);
  const [toY, toM, toD] = toStr.split("-").map(Number);
  const pad = (n) => String(n).padStart(2, "0");

  const current = new Date(Date.UTC(fromY, fromM - 1, fromD));
  const end = new Date(Date.UTC(toY, toM - 1, toD));

  while (current <= end) {
    out.push(
      `${current.getUTCFullYear()}-${pad(current.getUTCMonth() + 1)}-${pad(current.getUTCDate())}`,
    );
    current.setUTCDate(current.getUTCDate() + 1);
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
    (v) => normalizeAppointmentKind(v) !== null,
    "kind must be DROPOFF | WAIT | DUE_BY",
  );

  optionalIfPresent(
    "status",
    (v) => normalizeAppointmentStatus(v) !== null,
    `status must be ${APPOINTMENT_STATUSES.join(" | ")}`,
  );

  optionalIfPresent(
    "priorityTime",
    (v) => v === null || normalizeTimeMaybe(v) !== null,
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
    const effKind = normalizeAppointmentKind(kind) || "DROPOFF";
    const effPT = normalizeTimeMaybe(body.priorityTime);
    if (effKind === "DROPOFF" && effPT !== null)
      errors.push("priorityTime must be null for DROPOFF");
    if (["WAIT", "DUE_BY"].includes(effKind) && effPT === null)
      errors.push("priorityTime is required for WAIT/DUE_BY");
  } else {
    // In partial update, only validate consistency if both provided
    if (kind && pt !== undefined) {
      const normalizedKind = normalizeAppointmentKind(kind);
      const effPT = normalizeTimeMaybe(pt);
      if (normalizedKind === "DROPOFF" && effPT !== null)
        errors.push("priorityTime must be null for DROPOFF");
      if (["WAIT", "DUE_BY"].includes(normalizedKind) && effPT === null)
        errors.push("priorityTime is required for WAIT/DUE_BY");
    }
  }

  return errors;
}

function validateDraftLockPayload(body, { partial = false } = {}) {
  const errors = [];
  const payload = body || {};

  const requiredIfNotPartial = (key, checkFn, msg) => {
    if (!partial) {
      if (!checkFn(payload[key])) errors.push(msg);
    } else if (payload[key] !== undefined && !checkFn(payload[key])) {
      errors.push(msg);
    }
  };

  requiredIfNotPartial(
    "scheduledDate",
    (v) => isValidDateString(v),
    "scheduledDate must be YYYY-MM-DD",
  );
  requiredIfNotPartial(
    "kind",
    (v) => normalizeAppointmentKind(v) !== null,
    "kind must be DROPOFF | WAIT | DUE_BY",
  );
  requiredIfNotPartial(
    "slotsRequired",
    (v) => Number.isInteger(v) && v >= 1,
    "slotsRequired must be an integer >= 1",
  );
  requiredIfNotPartial(
    "isCapacityOverride",
    (v) => typeof v === "boolean",
    "isCapacityOverride must be boolean",
  );
  requiredIfNotPartial(
    "isWaitLimitOverride",
    (v) => typeof v === "boolean",
    "isWaitLimitOverride must be boolean",
  );

  return errors;
}

function normalizeDraftLockPayload(body, fallback = {}) {
  const payload = body || {};
  return {
    scheduledDate: payload.scheduledDate ?? fallback.scheduledDate ?? "",
    kind:
      normalizeAppointmentKind(payload.kind) ??
      normalizeAppointmentKind(fallback.kind) ??
      "DROPOFF",
    slotsRequired: Math.max(
      1,
      Number(payload.slotsRequired ?? fallback.slotsRequired ?? 1),
    ),
    isCapacityOverride:
      payload.isCapacityOverride === undefined
        ? Boolean(fallback.isCapacityOverride)
        : Boolean(payload.isCapacityOverride),
    isWaitLimitOverride:
      payload.isWaitLimitOverride === undefined
        ? Boolean(fallback.isWaitLimitOverride)
        : Boolean(payload.isWaitLimitOverride),
  };
}

function normalizeDraftLockRow(row) {
  if (!row) return null;
  return {
    token: String(row.token),
    scheduledDate: toDateOnlyString(row.scheduledDate) || row.scheduledDate,
    kind: normalizeAppointmentKind(row.kind) || "DROPOFF",
    slotsRequired: Math.max(1, Number(row.slotsRequired || 1)),
    isCapacityOverride: Number(row.isCapacityOverride) === 1,
    isWaitLimitOverride: Number(row.isWaitLimitOverride) === 1,
    expiresAt: toIsoTimestamp(row.expiresAt),
  };
}

function normalizeDraftLockToken(rawToken) {
  if (typeof rawToken !== "string") return "";
  const trimmed = rawToken.trim();
  if (trimmed.length < 8 || trimmed.length > 128) return "";
  return trimmed;
}

async function purgeExpiredDraftLocks(conn) {
  await conn.query(`DELETE FROM appointmentDraftLock WHERE expiresAt <= NOW()`);
}

async function getDraftLockByToken(token, conn, { forUpdate = false } = {}) {
  const lockToken = normalizeDraftLockToken(token);
  if (!lockToken) return null;
  const forUpdateSql = forUpdate ? " FOR UPDATE" : "";
  const [[row]] = await conn.query(
    `
    SELECT
      token,
      scheduledDate,
      kind,
      slotsRequired,
      isCapacityOverride,
      isWaitLimitOverride,
      expiresAt
    FROM appointmentDraftLock
    WHERE token = ?
      AND expiresAt > NOW()
    ${forUpdateSql}
    `,
    [lockToken],
  );
  return normalizeDraftLockRow(row);
}

async function getDraftLockAggregateForDate(
  dateStr,
  conn,
  { excludeToken = null } = {},
) {
  const lockToken = normalizeDraftLockToken(excludeToken);
  const params = [dateStr];
  const excludeSql = lockToken ? "AND token <> ?" : "";
  if (lockToken) params.push(lockToken);

  const [[agg]] = await conn.query(
    `
    SELECT
      COUNT(*) AS lockCount,
      COALESCE(SUM(CASE WHEN isCapacityOverride = 0 THEN slotsRequired ELSE 0 END), 0) AS lockedSlots,
      COALESCE(SUM(CASE WHEN kind IN ('WAIT', 'DUE_BY') AND isWaitLimitOverride = 0 THEN 1 ELSE 0 END), 0) AS lockedWait
    FROM appointmentDraftLock
    WHERE scheduledDate = ?
      AND expiresAt > NOW()
      ${excludeSql}
    `,
    params,
  );

  return {
    lockCount: Number(agg.lockCount || 0),
    lockedSlots: Number(agg.lockedSlots || 0),
    lockedWait: Number(agg.lockedWait || 0),
  };
}

function normalizeDateList(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = toDateOnlyString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function sendSseEvent(client, eventName, payload) {
  client.write(`event: ${eventName}\n`);
  client.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastScheduleChanged({
  dates = [],
  reason = "unknown",
  extra = {},
} = {}) {
  if (realtimeClients.size === 0) return;
  const normalizedDates = normalizeDateList(dates);
  const payload = {
    at: new Date().toISOString(),
    reason,
    dates: normalizedDates,
    ...extra,
  };
  for (const client of realtimeClients) {
    try {
      sendSseEvent(client, "schedule.changed", payload);
    } catch {
      realtimeClients.delete(client);
    }
  }
}

let draftLockSweepInFlight = false;
async function sweepExpiredDraftLocksAndBroadcast() {
  if (draftLockSweepInFlight) return;
  draftLockSweepInFlight = true;
  try {
    const [rows] = await db.query(
      `
      SELECT DISTINCT scheduledDate
      FROM appointmentDraftLock
      WHERE expiresAt <= NOW()
      `,
    );
    const expiredDates = normalizeDateList(
      rows.map((row) => row.scheduledDate),
    );
    if (expiredDates.length === 0) return;
    await purgeExpiredDraftLocks(db);
    broadcastScheduleChanged({
      dates: expiredDates,
      reason: "draft_lock_expired",
    });
  } catch (err) {
    console.error("Unable to sweep expired draft locks:", err.message);
  } finally {
    draftLockSweepInFlight = false;
  }
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

  const [rows] = await conn.query(
    `
    SELECT
      m.id,
      m.fname,
      m.lname,
      mo.leaveType,
      mo.jobsDropped
    FROM mechanic AS m
    LEFT JOIN mechanicOffDay AS mo
      ON mo.mechanic_id = m.id
      AND mo.date = ?
    ORDER BY m.id ASC
    `,
    [dateStr],
  );

  const totalMechanics = rows.length;
  let workingMechanics = 0;
  let partialJobsDropped = 0;

  for (const row of rows) {
    const leaveType = row.leaveType || null;
    const isDefaultOffByPolicy = isDefaultOffMechanicRow(row);
    const isWorking = isDefaultOffByPolicy
      ? leaveType === "FULL" || leaveType === "PART"
      : leaveType !== "FULL";

    if (isWorking) {
      workingMechanics += 1;
    }

    if (leaveType === "PART") {
      partialJobsDropped += Math.max(0, Number(row.jobsDropped || 0));
    }
  }

  const fullOffCount = Math.max(0, totalMechanics - workingMechanics);
  const baseCapacity = baseCapacityByMechanics(workingMechanics);
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
async function getDaySummary(
  dateStr,
  conn,
  { includeDraftLocks = true, excludeDraftLockToken = null } = {},
) {
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
  const draftLocks = includeDraftLocks
    ? await getDraftLockAggregateForDate(dateStr, conn, {
        excludeToken: excludeDraftLockToken,
      })
    : {
        lockCount: 0,
        lockedSlots: 0,
        lockedWait: 0,
      };

  const effectiveUsedSlots = usedSlots + draftLocks.lockedSlots;
  const effectiveWaitUsed = waitUsed + draftLocks.lockedWait;

  return {
    date: dateStr,
    ...cap,
    usedSlots,
    remainingSlots: cap.capacitySlots - usedSlots,
    effectiveUsedSlots,
    effectiveRemainingSlots: cap.capacitySlots - effectiveUsedSlots,
    overbookedSlots,
    waitLimit,
    waitUsed,
    waitRemaining: waitLimit - waitUsed,
    effectiveWaitUsed,
    effectiveWaitRemaining: waitLimit - effectiveWaitUsed,
    waitOverrides,
    draftLockCount: draftLocks.lockCount,
    draftLockedSlots: draftLocks.lockedSlots,
    draftLockedWait: draftLocks.lockedWait,
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
  if (!row) return null;

  const scheduledDate = toDateOnlyString(row.scheduledDate);
  if (scheduledDate) row.scheduledDate = scheduledDate;

  return row;
}

function formatMechanicDisplayName(row) {
  const parts = [row?.fname, row?.lname]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  return `Mechanic #${row?.id ?? "unknown"}`;
}

async function getMechanicAssignmentsForDate(dateStr, conn) {
  const [rows] = await conn.query(
    `
    SELECT
      m.id,
      m.fname,
      m.lname,
      mo.leaveType,
      mo.time,
      mo.jobsDropped
    FROM mechanic AS m
    LEFT JOIN mechanicOffDay AS mo
      ON mo.mechanic_id = m.id
      AND mo.date = ?
    ORDER BY m.id ASC
    `,
    [dateStr],
  );

  return rows.map((row) => {
    const leaveType = row.leaveType || null;
    const isDefaultOffByPolicy = isDefaultOffMechanicRow(row);
    const jobsDropped =
      row.jobsDropped === null || row.jobsDropped === undefined
        ? null
        : Number(row.jobsDropped);
    const assignmentStatus = isDefaultOffByPolicy
      ? leaveType === "PART"
        ? "PART_OFF"
        : leaveType === "FULL"
          ? "WORKING"
          : "FULL_OFF"
      : leaveType === "FULL"
        ? "FULL_OFF"
        : leaveType === "PART"
          ? "PART_OFF"
          : "WORKING";
    const normalizedLeaveType =
      assignmentStatus === "PART_OFF"
        ? "PART"
        : assignmentStatus === "FULL_OFF"
          ? "FULL"
          : null;

    return {
      id: Number(row.id),
      fname: row.fname || "",
      lname: row.lname || "",
      name: formatMechanicDisplayName(row),
      isWorking: assignmentStatus !== "FULL_OFF",
      assignmentStatus,
      leaveType: normalizedLeaveType,
      time: row.time || null,
      jobsDropped,
      defaultOffByPolicy: isDefaultOffByPolicy,
    };
  });
}

app.get("/realtime/schedule", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  res.write("retry: 5000\n\n");
  sendSseEvent(res, "connected", {
    at: new Date().toISOString(),
    lockTtlSeconds: DRAFT_LOCK_TTL_SECONDS,
  });
  realtimeClients.add(res);

  const keepalive = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      clearInterval(keepalive);
      realtimeClients.delete(res);
    }
  }, SSE_KEEPALIVE_MS);

  req.on("close", () => {
    clearInterval(keepalive);
    realtimeClients.delete(res);
  });
});

app.post("/appointment-locks", async (req, res) => {
  const partialErrors = validateDraftLockPayload(req.body || {}, {
    partial: true,
  });
  if (partialErrors.length > 0) {
    return res
      .status(400)
      .json({ error: "VALIDATION_ERROR", details: partialErrors });
  }

  const payload = normalizeDraftLockPayload(req.body);
  const errors = validateDraftLockPayload(payload, { partial: false });
  if (errors.length > 0) {
    return res.status(400).json({ error: "VALIDATION_ERROR", details: errors });
  }

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
    await purgeExpiredDraftLocks(conn);
    await lockScheduleDay(payload.scheduledDate, conn);

    const summary = await getDaySummary(payload.scheduledDate, conn, {
      includeDraftLocks: false,
    });
    const draftLocks = await getDraftLockAggregateForDate(
      payload.scheduledDate,
      conn,
    );
    const effectiveUsedSlots = summary.usedSlots + draftLocks.lockedSlots;
    const effectiveWaitUsed = summary.waitUsed + draftLocks.lockedWait;

    if (!payload.isCapacityOverride) {
      if (effectiveUsedSlots + payload.slotsRequired > summary.capacitySlots) {
        await conn.rollback();
        return res.status(409).json({
          error: "DAY_CAPACITY_FULL",
          message: "That day is full (capacity).",
          date: payload.scheduledDate,
          capacitySlots: summary.capacitySlots,
          usedSlots: summary.usedSlots,
          draftLockedSlots: draftLocks.lockedSlots,
          attemptedSlots: payload.slotsRequired,
          remainingSlots: summary.capacitySlots - effectiveUsedSlots,
        });
      }
    }

    if (
      ["WAIT", "DUE_BY"].includes(payload.kind) &&
      !payload.isWaitLimitOverride
    ) {
      if (effectiveWaitUsed + 1 > summary.waitLimit) {
        await conn.rollback();
        return res.status(409).json({
          error: "WAIT_LIMIT_REACHED",
          message: "Wait/Due-by appointments are full for that day.",
          date: payload.scheduledDate,
          waitLimit: summary.waitLimit,
          waitUsed: summary.waitUsed,
          draftLockedWait: draftLocks.lockedWait,
          waitRemaining: summary.waitLimit - effectiveWaitUsed,
        });
      }
    }

    const token = createDraftLockToken();
    await conn.query(
      `
      INSERT INTO appointmentDraftLock
      (token, scheduledDate, kind, slotsRequired, isCapacityOverride, isWaitLimitOverride, expiresAt)
      VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))
      `,
      [
        token,
        payload.scheduledDate,
        payload.kind,
        payload.slotsRequired,
        payload.isCapacityOverride ? 1 : 0,
        payload.isWaitLimitOverride ? 1 : 0,
        DRAFT_LOCK_TTL_SECONDS,
      ],
    );

    const lock = await getDraftLockByToken(token, conn);
    const summaryAfter = await getDaySummary(payload.scheduledDate, conn);
    await conn.commit();

    broadcastScheduleChanged({
      dates: [payload.scheduledDate],
      reason: "draft_lock_created",
    });

    res.status(201).json({ lock, summary: summaryAfter });
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    res.status(500).json({ error: "SERVER_ERROR", message: err.message });
  } finally {
    conn.release();
  }
});

app.put("/appointment-locks/:token", async (req, res) => {
  const token = normalizeDraftLockToken(req.params.token);
  if (!token) {
    return res
      .status(400)
      .json({ error: "BAD_REQUEST", message: "Invalid lock token" });
  }

  const partialErrors = validateDraftLockPayload(req.body || {}, {
    partial: true,
  });
  if (partialErrors.length > 0) {
    return res
      .status(400)
      .json({ error: "VALIDATION_ERROR", details: partialErrors });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await purgeExpiredDraftLocks(conn);

    const existing = await getDraftLockByToken(token, conn, {
      forUpdate: true,
    });
    if (!existing) {
      await conn.rollback();
      return res.status(404).json({
        error: "LOCK_NOT_FOUND",
        message: "Draft lock not found or expired.",
      });
    }

    const payload = normalizeDraftLockPayload(req.body, existing);
    const payloadErrors = validateDraftLockPayload(payload, { partial: false });
    if (payloadErrors.length > 0) {
      await conn.rollback();
      return res
        .status(400)
        .json({ error: "VALIDATION_ERROR", details: payloadErrors });
    }

    if (isSunday(payload.scheduledDate)) {
      await conn.rollback();
      return res.status(409).json({
        error: "SHOP_CLOSED",
        message: "No appointments can be scheduled on Sundays.",
        date: payload.scheduledDate,
      });
    }

    const lockDates = normalizeDateList([
      existing.scheduledDate,
      payload.scheduledDate,
    ]).sort();
    for (const dateStr of lockDates) {
      await lockScheduleDay(dateStr, conn);
    }

    const summary = await getDaySummary(payload.scheduledDate, conn, {
      includeDraftLocks: false,
    });
    const draftLocks = await getDraftLockAggregateForDate(
      payload.scheduledDate,
      conn,
      {
        excludeToken: token,
      },
    );
    const effectiveUsedSlots = summary.usedSlots + draftLocks.lockedSlots;
    const effectiveWaitUsed = summary.waitUsed + draftLocks.lockedWait;

    if (!payload.isCapacityOverride) {
      if (effectiveUsedSlots + payload.slotsRequired > summary.capacitySlots) {
        await conn.rollback();
        return res.status(409).json({
          error: "DAY_CAPACITY_FULL",
          message: "That day is full (capacity).",
          date: payload.scheduledDate,
          capacitySlots: summary.capacitySlots,
          usedSlots: summary.usedSlots,
          draftLockedSlots: draftLocks.lockedSlots,
          attemptedSlots: payload.slotsRequired,
          remainingSlots: summary.capacitySlots - effectiveUsedSlots,
        });
      }
    }

    if (
      ["WAIT", "DUE_BY"].includes(payload.kind) &&
      !payload.isWaitLimitOverride
    ) {
      if (effectiveWaitUsed + 1 > summary.waitLimit) {
        await conn.rollback();
        return res.status(409).json({
          error: "WAIT_LIMIT_REACHED",
          message: "Wait/Due-by appointments are full for that day.",
          date: payload.scheduledDate,
          waitLimit: summary.waitLimit,
          waitUsed: summary.waitUsed,
          draftLockedWait: draftLocks.lockedWait,
          waitRemaining: summary.waitLimit - effectiveWaitUsed,
        });
      }
    }

    await conn.query(
      `
      UPDATE appointmentDraftLock
      SET scheduledDate = ?,
          kind = ?,
          slotsRequired = ?,
          isCapacityOverride = ?,
          isWaitLimitOverride = ?,
          expiresAt = DATE_ADD(NOW(), INTERVAL ? SECOND)
      WHERE token = ?
      `,
      [
        payload.scheduledDate,
        payload.kind,
        payload.slotsRequired,
        payload.isCapacityOverride ? 1 : 0,
        payload.isWaitLimitOverride ? 1 : 0,
        DRAFT_LOCK_TTL_SECONDS,
        token,
      ],
    );

    const lock = await getDraftLockByToken(token, conn);
    const summaryAfter = await getDaySummary(payload.scheduledDate, conn);
    await conn.commit();

    const affectsAvailability =
      existing.scheduledDate !== payload.scheduledDate ||
      existing.kind !== payload.kind ||
      existing.slotsRequired !== payload.slotsRequired ||
      existing.isCapacityOverride !== payload.isCapacityOverride ||
      existing.isWaitLimitOverride !== payload.isWaitLimitOverride;
    if (affectsAvailability) {
      broadcastScheduleChanged({
        dates: [existing.scheduledDate, payload.scheduledDate],
        reason: "draft_lock_updated",
      });
    }

    res.json({ lock, summary: summaryAfter });
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    res.status(500).json({ error: "SERVER_ERROR", message: err.message });
  } finally {
    conn.release();
  }
});

app.delete("/appointment-locks/:token", async (req, res) => {
  const token = normalizeDraftLockToken(req.params.token);
  if (!token) {
    return res
      .status(400)
      .json({ error: "BAD_REQUEST", message: "Invalid lock token" });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await purgeExpiredDraftLocks(conn);

    const existing = await getDraftLockByToken(token, conn, {
      forUpdate: true,
    });
    if (!existing) {
      await conn.rollback();
      return res.json({ released: false, token });
    }

    await lockScheduleDay(existing.scheduledDate, conn);
    await conn.query(`DELETE FROM appointmentDraftLock WHERE token = ?`, [
      token,
    ]);

    const summaryAfter = await getDaySummary(existing.scheduledDate, conn);
    await conn.commit();

    broadcastScheduleChanged({
      dates: [existing.scheduledDate],
      reason: "draft_lock_released",
    });

    res.json({
      released: true,
      token,
      date: existing.scheduledDate,
      summary: summaryAfter,
    });
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
// Schedule endpoints
// -----------------------

// Monthly summary for React-Calendar tiles
// GET /schedule/month?year=2026&month=2
app.get("/schedule/month", async (req, res) => {
  try {
    const { year, month } = req.query;
    const { fromStr, toStr } = toMonthRange(year, month);
    const days = datesBetweenInclusive(fromStr, toStr);
    await purgeExpiredDraftLocks(db);

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
        effectiveUsedSlots: s.effectiveUsedSlots,
        effectiveRemainingSlots: s.effectiveRemainingSlots,
        waitLimit: s.waitLimit,
        waitUsed: s.waitUsed,
        waitRemaining: s.waitRemaining,
        effectiveWaitUsed: s.effectiveWaitUsed,
        effectiveWaitRemaining: s.effectiveWaitRemaining,
        overbookedSlots: s.overbookedSlots,
        workingMechanics: s.workingMechanics,
        partialJobsDropped: s.partialJobsDropped,
        draftLockCount: s.draftLockCount,
        draftLockedSlots: s.draftLockedSlots,
        draftLockedWait: s.draftLockedWait,
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

// Per-day mechanic assignment checklist
// GET /schedule/day/mechanics?date=YYYY-MM-DD
app.get("/schedule/day/mechanics", async (req, res) => {
  try {
    const { date } = req.query;
    if (!isValidDateString(date)) {
      return res
        .status(400)
        .json({ error: "BAD_REQUEST", message: "date must be YYYY-MM-DD" });
    }

    await purgeExpiredDraftLocks(db);
    const [summary, mechanics] = await Promise.all([
      getDaySummary(date, db),
      getMechanicAssignmentsForDate(date, db),
    ]);

    res.json({ date, summary, mechanics });
  } catch (err) {
    res.status(500).json({ error: "SERVER_ERROR", message: err.message });
  }
});

// Replace full-day mechanic assignments for one date.
// Body (recommended): {
//   assignments: [{ mechanicId, status: WORKING|FULL_OFF|PART_OFF, time?, jobsDropped? }]
// }
// Legacy body (still supported): { workingMechanicIds: number[] }
// PUT /schedule/day/mechanics?date=YYYY-MM-DD
app.put("/schedule/day/mechanics", async (req, res) => {
  const { date } = req.query;
  if (!isValidDateString(date)) {
    return res
      .status(400)
      .json({ error: "BAD_REQUEST", message: "date must be YYYY-MM-DD" });
  }

  if (isSunday(date)) {
    return res.status(409).json({
      error: "SHOP_CLOSED",
      message: "No mechanics can be assigned on Sundays.",
      date,
    });
  }

  const hasAssignmentsPayload = Array.isArray(req.body?.assignments);
  const hasLegacyWorkingIds = Array.isArray(req.body?.workingMechanicIds);
  if (!hasAssignmentsPayload && !hasLegacyWorkingIds) {
    return res.status(400).json({
      error: "VALIDATION_ERROR",
      details: [
        "Provide either assignments[] or workingMechanicIds[] in the request body",
      ],
    });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await purgeExpiredDraftLocks(conn);
    await lockScheduleDay(date, conn);

    const [mechanicRows] = await conn.query(
      `SELECT id, fname, lname FROM mechanic ORDER BY id ASC`,
    );
    const allMechanicIds = mechanicRows.map((row) => Number(row.id));
    const allMechanicSet = new Set(allMechanicIds);
    const defaultOffMechanicIdSet = new Set(
      mechanicRows
        .filter((row) => isDefaultOffMechanicRow(row))
        .map((row) => Number(row.id)),
    );

    const assignmentById = new Map();

    if (hasAssignmentsPayload) {
      const details = [];
      for (const item of req.body.assignments) {
        const mechanicId = Number(item?.mechanicId ?? item?.id);
        const status = String(item?.status || "")
          .trim()
          .toUpperCase();

        if (!Number.isInteger(mechanicId) || mechanicId < 1) {
          details.push("assignments[].mechanicId must be a positive integer");
          continue;
        }
        if (!["WORKING", "FULL_OFF", "PART_OFF"].includes(status)) {
          details.push(
            `assignments[mechanicId=${mechanicId}] status must be WORKING, FULL_OFF, or PART_OFF`,
          );
          continue;
        }
        if (assignmentById.has(mechanicId)) {
          details.push(`Duplicate assignment for mechanic id ${mechanicId}`);
          continue;
        }

        if (status === "PART_OFF") {
          const partTime = normalizeTimeMaybe(item?.time);
          const jobsDropped = Number(item?.jobsDropped ?? 0);

          if (partTime === null) {
            details.push(
              `assignments[mechanicId=${mechanicId}] time must be HH:MM or HH:MM:SS for PART_OFF`,
            );
            continue;
          }
          if (!Number.isInteger(jobsDropped) || jobsDropped < 0) {
            details.push(
              `assignments[mechanicId=${mechanicId}] jobsDropped must be an integer >= 0`,
            );
            continue;
          }

          assignmentById.set(mechanicId, {
            status,
            time: partTime,
            jobsDropped,
          });
          continue;
        }

        assignmentById.set(mechanicId, {
          status,
          time: null,
          jobsDropped: null,
        });
      }

      const unknownIds = [...assignmentById.keys()].filter(
        (id) => !allMechanicSet.has(id),
      );
      if (unknownIds.length > 0) {
        details.push(`Unknown mechanic id(s): ${unknownIds.join(", ")}`);
      }

      if (details.length > 0) {
        await conn.rollback();
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          details,
        });
      }
    } else {
      const numericIds = req.body.workingMechanicIds.map((id) => Number(id));
      const hasInvalidId = numericIds.some(
        (id) => !Number.isInteger(id) || id < 1,
      );
      if (hasInvalidId) {
        await conn.rollback();
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          details: ["workingMechanicIds must contain positive integer ids"],
        });
      }

      const workingIdSet = new Set(numericIds);
      const invalidIds = [...workingIdSet].filter(
        (id) => !allMechanicSet.has(id),
      );
      if (invalidIds.length > 0) {
        await conn.rollback();
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          details: [`Unknown mechanic id(s): ${invalidIds.join(", ")}`],
        });
      }

      for (const mechanicId of allMechanicIds) {
        assignmentById.set(mechanicId, {
          status: workingIdSet.has(mechanicId) ? "WORKING" : "FULL_OFF",
          time: null,
          jobsDropped: null,
        });
      }
    }

    for (const mechanicId of allMechanicIds) {
      if (!assignmentById.has(mechanicId)) {
        assignmentById.set(mechanicId, {
          status: defaultOffMechanicIdSet.has(mechanicId)
            ? "FULL_OFF"
            : "WORKING",
          time: null,
          jobsDropped: null,
        });
      }
    }

    if (allMechanicIds.length > 0) {
      const deletePlaceholders = allMechanicIds.map(() => "?").join(", ");
      await conn.query(
        `
        DELETE FROM mechanicOffDay
        WHERE date = ?
          AND mechanic_id IN (${deletePlaceholders})
        `,
        [date, ...allMechanicIds],
      );
    }

    const rowsToInsert = [];
    for (const [mechanicId, assignment] of assignmentById.entries()) {
      const isDefaultOffByPolicy = defaultOffMechanicIdSet.has(
        Number(mechanicId),
      );

      if (isDefaultOffByPolicy && assignment.status === "WORKING") {
        // For default-off mechanics, a FULL row acts as an explicit
        // "working today" override.
        rowsToInsert.push([mechanicId, date, "FULL", null, null]);
      } else if (assignment.status === "FULL_OFF" && !isDefaultOffByPolicy) {
        rowsToInsert.push([mechanicId, date, "FULL", null, null]);
      } else if (assignment.status === "PART_OFF") {
        rowsToInsert.push([
          mechanicId,
          date,
          "PART",
          assignment.time,
          assignment.jobsDropped,
        ]);
      }
    }

    if (rowsToInsert.length > 0) {
      const valuesSql = rowsToInsert.map(() => "(?, ?, ?, ?, ?)").join(", ");
      await conn.query(
        `
        INSERT INTO mechanicOffDay (mechanic_id, date, leaveType, time, jobsDropped)
        VALUES ${valuesSql}
        `,
        rowsToInsert.flat(),
      );
    }

    const summary = await getDaySummary(date, conn);
    const mechanics = await getMechanicAssignmentsForDate(date, conn);

    await conn.commit();
    broadcastScheduleChanged({
      dates: [date],
      reason: "mechanic_assignments_updated",
    });
    res.json({ date, summary, mechanics });
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    res.status(500).json({ error: "SERVER_ERROR", message: err.message });
  } finally {
    conn.release();
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

    await purgeExpiredDraftLocks(db);
    const summary = await getDaySummary(date, db);
    const [rows] = await db.query(
      `SELECT * FROM appointments WHERE scheduledDate = ? ORDER BY (isFirstJob = 1) DESC, priorityTime IS NULL, priorityTime ASC, id ASC`,
      [date],
    );

    const appointments = rows.map((row) => {
      const normalizedDate = toDateOnlyString(row.scheduledDate);
      return {
        ...row,
        scheduledDate: normalizedDate || row.scheduledDate,
      };
    });

    res.json({ date, summary, appointments });
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
    kind: normalizeAppointmentKind(req.body.kind) || "DROPOFF",
    status:
      normalizeAppointmentStatus(req.body.status) || DEFAULT_APPOINTMENT_STATUS,
    priorityTime: normalizeTimeMaybe(req.body.priorityTime),
    isFirstJob: Boolean(req.body.isFirstJob),
    slotsRequired: Number(req.body.slotsRequired ?? 1),
    isCapacityOverride: Boolean(req.body.isCapacityOverride),
    isWaitLimitOverride: Boolean(req.body.isWaitLimitOverride),
    draftLockToken: normalizeDraftLockToken(req.body.draftLockToken),
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
    await purgeExpiredDraftLocks(conn);

    // Lock the day row so two schedulers can't both "pass" capacity checks at once
    await lockScheduleDay(payload.scheduledDate, conn);

    // Recompute summary inside the transaction
    const summary = await getDaySummary(payload.scheduledDate, conn, {
      includeDraftLocks: false,
    });
    const draftLocks = await getDraftLockAggregateForDate(
      payload.scheduledDate,
      conn,
      {
        excludeToken: payload.draftLockToken,
      },
    );
    const effectiveUsedSlots = summary.usedSlots + draftLocks.lockedSlots;
    const effectiveWaitUsed = summary.waitUsed + draftLocks.lockedWait;

    // Capacity rule
    if (!payload.isCapacityOverride) {
      if (effectiveUsedSlots + payload.slotsRequired > summary.capacitySlots) {
        await conn.rollback();
        return res.status(409).json({
          error: "DAY_CAPACITY_FULL",
          message: "That day is full (capacity).",
          date: payload.scheduledDate,
          capacitySlots: summary.capacitySlots,
          usedSlots: summary.usedSlots,
          draftLockedSlots: draftLocks.lockedSlots,
          attemptedSlots: payload.slotsRequired,
          remainingSlots: summary.capacitySlots - effectiveUsedSlots,
        });
      }
    }

    // Wait limit rule
    if (
      ["WAIT", "DUE_BY"].includes(payload.kind) &&
      !payload.isWaitLimitOverride
    ) {
      if (effectiveWaitUsed + 1 > summary.waitLimit) {
        await conn.rollback();
        return res.status(409).json({
          error: "WAIT_LIMIT_REACHED",
          message: "Wait/Due-by appointments are full for that day.",
          date: payload.scheduledDate,
          waitLimit: summary.waitLimit,
          waitUsed: summary.waitUsed,
          draftLockedWait: draftLocks.lockedWait,
          waitRemaining: summary.waitLimit - effectiveWaitUsed,
        });
      }
    }

    // Insert
    const [result] = await conn.query(
      `
      INSERT INTO appointments
      (scheduledDate, lname, vehicle, phone, services, kind, status, priorityTime,
       isFirstJob, slotsRequired, isCapacityOverride, isWaitLimitOverride)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        payload.scheduledDate,
        payload.lname,
        payload.vehicle,
        payload.phone,
        payload.services,
        payload.kind,
        payload.status,
        payload.priorityTime,
        payload.isFirstJob ? 1 : 0,
        payload.slotsRequired,
        payload.isCapacityOverride ? 1 : 0,
        payload.isWaitLimitOverride ? 1 : 0,
      ],
    );

    const insertedId = result.insertId;

    if (payload.draftLockToken) {
      await conn.query(`DELETE FROM appointmentDraftLock WHERE token = ?`, [
        payload.draftLockToken,
      ]);
    }

    // New summary after insert
    const newSummary = await getDaySummary(payload.scheduledDate, conn);

    await conn.commit();
    broadcastScheduleChanged({
      dates: [payload.scheduledDate],
      reason: "appointment_created",
    });

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
    await purgeExpiredDraftLocks(conn);

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
      kind:
        normalizeAppointmentKind(req.body.kind ?? existing.kind) || "DROPOFF",
      status:
        req.body.status === undefined
          ? normalizeAppointmentStatus(existing.status) ||
            DEFAULT_APPOINTMENT_STATUS
          : normalizeAppointmentStatus(req.body.status),
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
    const lockDates = normalizeDateList([oldDate, newDate]).sort();
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
      const draftLocks = await getDraftLockAggregateForDate(dateStr, conn);
      const effectiveUsedSlots = usedSlots + draftLocks.lockedSlots;
      const effectiveWaitUsed = waitUsed + draftLocks.lockedWait;

      return {
        date: dateStr,
        ...cap,
        usedSlots,
        remainingSlots: cap.capacitySlots - usedSlots,
        effectiveUsedSlots,
        effectiveRemainingSlots: cap.capacitySlots - effectiveUsedSlots,
        overbookedSlots,
        waitLimit,
        waitUsed,
        waitRemaining: waitLimit - waitUsed,
        effectiveWaitUsed,
        effectiveWaitRemaining: waitLimit - effectiveWaitUsed,
        draftLockedSlots: draftLocks.lockedSlots,
        draftLockedWait: draftLocks.lockedWait,
      };
    }

    const summaryNewDate = await getDaySummaryExcludingId(newDate, id);

    // Capacity rule on new date
    if (!updated.isCapacityOverride) {
      if (
        summaryNewDate.effectiveUsedSlots + updated.slotsRequired >
        summaryNewDate.capacitySlots
      ) {
        await conn.rollback();
        return res.status(409).json({
          error: "DAY_CAPACITY_FULL",
          message: "That day is full (capacity).",
          date: newDate,
          capacitySlots: summaryNewDate.capacitySlots,
          usedSlots: summaryNewDate.usedSlots,
          draftLockedSlots: summaryNewDate.draftLockedSlots,
          attemptedSlots: updated.slotsRequired,
          remainingSlots: summaryNewDate.effectiveRemainingSlots,
        });
      }
    }

    // Wait rule on new date
    if (
      ["WAIT", "DUE_BY"].includes(updated.kind) &&
      !updated.isWaitLimitOverride
    ) {
      if (summaryNewDate.effectiveWaitUsed + 1 > summaryNewDate.waitLimit) {
        await conn.rollback();
        return res.status(409).json({
          error: "WAIT_LIMIT_REACHED",
          message: "Wait/Due-by appointments are full for that day.",
          date: newDate,
          waitLimit: summaryNewDate.waitLimit,
          waitUsed: summaryNewDate.waitUsed,
          draftLockedWait: summaryNewDate.draftLockedWait,
          waitRemaining: summaryNewDate.effectiveWaitRemaining,
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
          status = ?,
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
        updated.status,
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
    broadcastScheduleChanged({
      dates: [oldDate, updated.scheduledDate],
      reason: "appointment_updated",
    });

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
    await purgeExpiredDraftLocks(conn);

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
    broadcastScheduleChanged({
      dates: [dateStr],
      reason: "appointment_deleted",
    });

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

https.createServer(options, app).listen(443, "0.0.0.0", () => {
  console.log("HTTPS server running on port 443");
});
