export function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function normalizeDate(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function getAvailabilityBucket(day, mode = "slots") {
  if (!day) return "unknown";
  const capacity =
    mode === "wait"
      ? Number(day.waitLimit || 0)
      : Number(day.capacitySlots || 0);
  const remaining =
    mode === "wait"
      ? Math.max(
          0,
          Number(day.effectiveWaitRemaining ?? day.waitRemaining ?? 0),
        )
      : Math.max(
          0,
          Number(day.effectiveRemainingSlots ?? day.remainingSlots ?? 0),
        );

  if (capacity <= 0) return "0";

  const ratio = remaining / capacity;
  if (ratio >= 0.8) return "4";
  if (ratio >= 0.6) return "3";
  if (ratio >= 0.4) return "2";
  if (ratio > 0) return "1";
  return "0";
}

export function formatPriorityTime(value) {
  if (!value) return "N/A";
  const [hoursPart, minutesPart] = String(value).split(":");
  const hours = Number(hoursPart);
  if (!Number.isFinite(hours) || !minutesPart) return String(value);

  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${minutesPart} ${suffix}`;
}

export function formatPhoneNumber(value) {
  if (!value) return "N/A";

  const raw = String(value).trim();
  if (!raw) return "N/A";

  const digits = raw.replace(/\D/g, "");
  const normalized =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;

  if (normalized.length !== 10) return raw;

  return `(${normalized.slice(0, 3)}) ${normalized.slice(3, 6)}-${normalized.slice(6)}`;
}

export function getAppointmentTypeLabel(appointment) {
  const kind = String(appointment?.kind || "DROPOFF")
    .trim()
    .toUpperCase();
  const kindLabel =
    kind === "WAIT" ? "Wait" : kind === "DUE_BY" ? "Due by" : "Dropoff";
  if (!["WAIT", "DUE_BY"].includes(kind)) return kindLabel;

  const priority = formatPriorityTime(appointment?.priorityTime);
  return priority === "N/A" ? kindLabel : `${kindLabel} @ ${priority}`;
}

export function getApiErrorMessage(error, fallbackMessage) {
  const details = error?.response?.data?.details;
  if (Array.isArray(details) && details.length > 0) {
    return details.join(" ");
  }

  return error?.response?.data?.message || fallbackMessage;
}

export function getInitialAppointmentForm(scheduledDate = "") {
  return {
    scheduledDate,
    lname: "",
    vehicle: "",
    phone: "",
    services: "",
    kind: "DROPOFF",
    priorityTime: "",
    isFirstJob: false,
    slotsRequired: "1",
    isCapacityOverride: false,
    isWaitLimitOverride: false,
  };
}

export function toTimeInputValue(value) {
  if (!value) return "";
  const [hoursPart, minutesPart] = String(value).split(":");
  if (!hoursPart || !minutesPart) return "";
  return `${String(hoursPart).padStart(2, "0")}:${String(minutesPart).padStart(2, "0")}`;
}

export function getMechanicAssignmentMode(mechanic) {
  const explicitStatus = String(mechanic?.assignmentStatus || "")
    .trim()
    .toUpperCase();
  if (["WORKING", "FULL_OFF", "PART_OFF"].includes(explicitStatus)) {
    return explicitStatus;
  }

  const leaveType = String(mechanic?.leaveType || "")
    .trim()
    .toUpperCase();
  if (leaveType === "FULL") return "FULL_OFF";
  if (leaveType === "PART") return "PART_OFF";
  return "WORKING";
}

export function getDefaultPartialTime(value) {
  return toTimeInputValue(value) || "12:00";
}

export const APPOINTMENT_STATUS_STEPS = [
  {
    value: "WAITING_FOR_DROPOFF",
    label: "Waiting for dropoff",
    short: "Dropoff",
  },
  {
    value: "QUEUED_FOR_TECHNICIAN",
    label: "Queued for technician",
    short: "Queued",
  },
  { value: "IN_SERVICE", label: "In service", short: "In service" },
  { value: "READY_FOR_PICKUP", label: "Ready for pickup", short: "Ready" },
];

const APPOINTMENT_STATUS_VALUES = APPOINTMENT_STATUS_STEPS.map(
  (step) => step.value,
);
const DEFAULT_APPOINTMENT_STATUS = APPOINTMENT_STATUS_STEPS[0].value;

export function normalizeAppointmentStatus(status) {
  const normalized = String(status || "")
    .trim()
    .toUpperCase();
  return APPOINTMENT_STATUS_VALUES.includes(normalized)
    ? normalized
    : DEFAULT_APPOINTMENT_STATUS;
}

export function getAppointmentStatusStepIndex(status) {
  const normalized = normalizeAppointmentStatus(status);
  const foundIndex = APPOINTMENT_STATUS_STEPS.findIndex(
    (step) => step.value === normalized,
  );
  return foundIndex >= 0 ? foundIndex : 0;
}

export function getAppointmentStatusLabel(status) {
  const normalized = normalizeAppointmentStatus(status);
  const matched = APPOINTMENT_STATUS_STEPS.find(
    (step) => step.value === normalized,
  );
  return matched ? matched.label : APPOINTMENT_STATUS_STEPS[0].label;
}

export function getAppointmentFormFromRecord(appointment) {
  const kind = appointment?.kind || "DROPOFF";
  return {
    scheduledDate: appointment?.scheduledDate || "",
    lname: appointment?.lname || "",
    vehicle: appointment?.vehicle || "",
    phone: appointment?.phone || "",
    services: appointment?.services || "",
    kind,
    priorityTime:
      kind === "WAIT" || kind === "DUE_BY"
        ? toTimeInputValue(appointment?.priorityTime)
        : "",
    isFirstJob: Number(appointment?.isFirstJob) === 1,
    slotsRequired: String(Math.max(1, Number(appointment?.slotsRequired || 1))),
    isCapacityOverride: Number(appointment?.isCapacityOverride) === 1,
    isWaitLimitOverride: Number(appointment?.isWaitLimitOverride) === 1,
  };
}
