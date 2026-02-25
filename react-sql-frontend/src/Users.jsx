import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import Calendar from "react-calendar";
import "react-calendar/dist/Calendar.css";
import "./Users.css";

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeDate(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function getAvailabilityBucket(day, mode = "slots") {
  if (!day) return "unknown";
  const capacity =
    mode === "wait"
      ? Number(day.waitLimit || 0)
      : Number(day.capacitySlots || 0);
  const remaining =
    mode === "wait"
      ? Math.max(0, Number(day.effectiveWaitRemaining ?? day.waitRemaining ?? 0))
      : Math.max(
          0,
          Number(day.effectiveRemainingSlots ?? day.remainingSlots ?? 0),
        );

  if (capacity <= 0) return "0";

  const ratio = remaining / capacity;
  if (ratio >= 0.8) return "4";
  if (ratio >= 0.6) return "3";
  if (ratio >= 0.4) return "2";
  if (ratio >= 0.2) return "1";
  return "0";
}

const LOCK_HEARTBEAT_MS = 25000;

function formatPriorityTime(value) {
  if (!value) return "N/A";
  const [hoursPart, minutesPart] = String(value).split(":");
  const hours = Number(hoursPart);
  if (!Number.isFinite(hours) || !minutesPart) return String(value);

  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${minutesPart} ${suffix}`;
}

function getApiErrorMessage(error, fallbackMessage) {
  const details = error?.response?.data?.details;
  if (Array.isArray(details) && details.length > 0) {
    return details.join(" ");
  }

  return error?.response?.data?.message || fallbackMessage;
}

function getInitialAppointmentForm(scheduledDate = "") {
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

function toTimeInputValue(value) {
  if (!value) return "";
  const [hoursPart, minutesPart] = String(value).split(":");
  if (!hoursPart || !minutesPart) return "";
  return `${String(hoursPart).padStart(2, "0")}:${String(minutesPart).padStart(2, "0")}`;
}

function getMechanicAssignmentMode(mechanic) {
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

function getDefaultPartialTime(value) {
  return toTimeInputValue(value) || "12:00";
}

const APPOINTMENT_STATUS_STEPS = [
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

function normalizeAppointmentStatus(status) {
  const normalized = String(status || "")
    .trim()
    .toUpperCase();
  return APPOINTMENT_STATUS_VALUES.includes(normalized)
    ? normalized
    : DEFAULT_APPOINTMENT_STATUS;
}

function getAppointmentStatusStepIndex(status) {
  const normalized = normalizeAppointmentStatus(status);
  const foundIndex = APPOINTMENT_STATUS_STEPS.findIndex(
    (step) => step.value === normalized,
  );
  return foundIndex >= 0 ? foundIndex : 0;
}

function getAppointmentStatusLabel(status) {
  const normalized = normalizeAppointmentStatus(status);
  const matched = APPOINTMENT_STATUS_STEPS.find(
    (step) => step.value === normalized,
  );
  return matched ? matched.label : APPOINTMENT_STATUS_STEPS[0].label;
}

function getAppointmentFormFromRecord(appointment) {
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

const Users = () => {
  const [selectedDate, setSelectedDate] = useState(() =>
    normalizeDate(new Date()),
  );
  const [activeStartDate, setActiveStartDate] = useState(() =>
    normalizeDate(new Date()),
  );
  const [availabilityByDate, setAvailabilityByDate] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [dayDetails, setDayDetails] = useState(null);
  const [isDayLoading, setIsDayLoading] = useState(false);
  const [dayError, setDayError] = useState("");
  const [availabilityMode, setAvailabilityMode] = useState("slots");
  const [refreshKey, setRefreshKey] = useState(0);
  const [isCreateFormOpen, setIsCreateFormOpen] = useState(false);
  const [editingAppointmentId, setEditingAppointmentId] = useState(null);
  const [deletingAppointmentId, setDeletingAppointmentId] = useState(null);
  const [statusUpdatingAppointmentId, setStatusUpdatingAppointmentId] =
    useState(null);
  const [isCreateSubmitting, setIsCreateSubmitting] = useState(false);
  const [isCreateLocking, setIsCreateLocking] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createSuccess, setCreateSuccess] = useState("");
  const [createLock, setCreateLock] = useState(null);
  const [isMechanicsModalOpen, setIsMechanicsModalOpen] = useState(false);
  const [mechanicAssignments, setMechanicAssignments] = useState([]);
  const [isMechanicsLoading, setIsMechanicsLoading] = useState(false);
  const [isMechanicsSaving, setIsMechanicsSaving] = useState(false);
  const [mechanicsError, setMechanicsError] = useState("");
  const [showAdvancedCreateFields, setShowAdvancedCreateFields] =
    useState(false);
  const [newAppointment, setNewAppointment] = useState(() =>
    getInitialAppointmentForm(toDateKey(normalizeDate(new Date()))),
  );

  const today = useMemo(() => normalizeDate(new Date()), []);

  const isPastDay = (date) => normalizeDate(date) < today;

  const isSunday = (date) => normalizeDate(date).getDay() === 0;
  const isCalendarDisabledDay = (date) => isSunday(date);
  const isPastOrSunday = (date) => isPastDay(date) || isSunday(date);

  useEffect(() => {
    const loadMonthAvailability = async () => {
      setIsLoading(true);
      setError("");

      try {
        const response = await axios.get("/schedule/month", {
          params: {
            year: activeStartDate.getFullYear(),
            month: activeStartDate.getMonth() + 1,
          },
        });

        const nextByDate = {};
        for (const day of response.data.days || []) {
          nextByDate[day.date] = day;
        }
        setAvailabilityByDate(nextByDate);
      } catch (loadError) {
        console.error(
          "There was an error fetching schedule availability!",
          loadError,
        );
        setAvailabilityByDate({});
        setError("Could not load appointment availability for this month.");
      } finally {
        setIsLoading(false);
      }
    };

    loadMonthAvailability();
  }, [activeStartDate, refreshKey]);

  useEffect(() => {
    let cancelled = false;

    const loadDayDetails = async () => {
      const normalizedSelectedDate = normalizeDate(selectedDate);
      if (normalizedSelectedDate.getDay() === 0) {
        setDayDetails(null);
        setDayError("");
        setIsDayLoading(false);
        return;
      }

      setIsDayLoading(true);
      setDayError("");
      setDayDetails(null);

      try {
        const response = await axios.get("/schedule/day", {
          params: { date: toDateKey(selectedDate) },
        });

        if (!cancelled) {
          setDayDetails(response.data || null);
        }
      } catch (loadError) {
        console.error(
          "There was an error fetching day appointment details!",
          loadError,
        );

        if (!cancelled) {
          setDayDetails(null);
          setDayError("Could not load appointments for this day.");
        }
      } finally {
        if (!cancelled) setIsDayLoading(false);
      }
    };

    loadDayDetails();

    return () => {
      cancelled = true;
    };
  }, [selectedDate, today, refreshKey]);

  useEffect(() => {
    const source = new EventSource("/realtime/schedule");
    const handleScheduleChange = () => {
      setRefreshKey((current) => current + 1);
    };

    source.addEventListener("schedule.changed", handleScheduleChange);
    source.onerror = () => {};

    return () => {
      source.removeEventListener("schedule.changed", handleScheduleChange);
      source.close();
    };
  }, []);

  useEffect(() => {
    setIsCreateFormOpen(false);
    setEditingAppointmentId(null);
    setStatusUpdatingAppointmentId(null);
    setCreateError("");
    setCreateSuccess("");
    setCreateLock(null);
    setIsCreateLocking(false);
    setIsMechanicsModalOpen(false);
    setMechanicAssignments([]);
    setIsMechanicsLoading(false);
    setIsMechanicsSaving(false);
    setMechanicsError("");
    setShowAdvancedCreateFields(false);
    setNewAppointment(getInitialAppointmentForm(toDateKey(selectedDate)));
  }, [selectedDate]);

  const selectedDayData =
    dayDetails?.summary || availabilityByDate[toDateKey(selectedDate)];
  const selectedRemaining = Math.max(
    0,
    Number(selectedDayData?.effectiveRemainingSlots ?? selectedDayData?.remainingSlots ?? 0),
  );
  const selectedCapacity = Number(selectedDayData?.capacitySlots || 0);
  const selectedUsed = Number(
    selectedDayData?.effectiveUsedSlots ?? selectedDayData?.usedSlots ?? 0,
  );
  const selectedAppointments = dayDetails?.appointments || [];
  const selectedWaitLimit = selectedDayData?.waitLimit || 0;
  const selectedWaitUsed =
    selectedDayData?.effectiveWaitUsed ?? selectedDayData?.waitUsed ?? 0;
  const selectedWaitRemaining = Math.max(
    0,
    Number(
      selectedDayData?.effectiveWaitRemaining ?? selectedDayData?.waitRemaining ?? 0,
    ),
  );
  const isWaitMode = availabilityMode === "wait";
  const selectedDateIsPastDay = isPastDay(selectedDate);
  const selectedDateIsSunday = isSunday(selectedDate);
  const canCreateForSelectedDate =
    !selectedDateIsPastDay && !selectedDateIsSunday;
  const isEditingAppointment = editingAppointmentId !== null;
  const needsPriorityTime = ["WAIT", "DUE_BY"].includes(newAppointment.kind);
  const shouldManageCreateLock =
    isCreateFormOpen && !isEditingAppointment && canCreateForSelectedDate;
  const hasActiveCreateLock = Boolean(createLock?.token);
  const createLockPayload = useMemo(
    () => ({
      scheduledDate: newAppointment.scheduledDate || toDateKey(selectedDate),
      kind: newAppointment.kind || "DROPOFF",
      slotsRequired: Math.max(1, Number(newAppointment.slotsRequired || 1)),
      isCapacityOverride: Boolean(newAppointment.isCapacityOverride),
      isWaitLimitOverride: Boolean(newAppointment.isWaitLimitOverride),
    }),
    [
      newAppointment.isCapacityOverride,
      newAppointment.isWaitLimitOverride,
      newAppointment.kind,
      newAppointment.scheduledDate,
      newAppointment.slotsRequired,
      selectedDate,
    ],
  );

  const resetCreateForm = () => {
    setNewAppointment(getInitialAppointmentForm(toDateKey(selectedDate)));
    setShowAdvancedCreateFields(false);
  };

  const openNewAppointmentForm = () => {
    setEditingAppointmentId(null);
    setCreateError("");
    setCreateSuccess("");
    resetCreateForm();
    setIsCreateFormOpen(true);
  };

  const closeAppointmentForm = () => {
    setIsCreateFormOpen(false);
    setEditingAppointmentId(null);
    setCreateError("");
    setCreateSuccess("");
    resetCreateForm();
  };

  const closeMechanicsModal = () => {
    if (isMechanicsSaving) return;
    setIsMechanicsModalOpen(false);
    setMechanicsError("");
    setMechanicAssignments([]);
    setIsMechanicsLoading(false);
  };

  const loadMechanicsForSelectedDate = async (dateKey) => {
    setMechanicsError("");
    setIsMechanicsLoading(true);

    try {
      const response = await axios.get("/schedule/day/mechanics", {
        params: { date: dateKey },
      });
      const nextAssignments = (response.data?.mechanics || []).map(
        (mechanic) => {
          const assignmentMode = getMechanicAssignmentMode(mechanic);
          return {
            ...mechanic,
            id: Number(mechanic.id),
            assignmentMode,
            partTime:
              assignmentMode === "PART_OFF"
                ? getDefaultPartialTime(mechanic.time)
                : "12:00",
            jobsDropped: String(Math.max(0, Number(mechanic.jobsDropped || 0))),
          };
        },
      );
      setMechanicAssignments(nextAssignments);
    } catch (loadError) {
      setMechanicAssignments([]);
      setMechanicsError(
        getApiErrorMessage(loadError, "Could not load mechanics for this day."),
      );
    } finally {
      setIsMechanicsLoading(false);
    }
  };

  const openMechanicsModal = () => {
    if (selectedDateIsSunday) return;
    setCreateError("");
    setCreateSuccess("");
    setMechanicsError("");
    setMechanicAssignments([]);
    setIsMechanicsModalOpen(true);
    void loadMechanicsForSelectedDate(toDateKey(selectedDate));
  };

  const handleMechanicWorkingChange = (mechanicId, isWorking) => {
    setMechanicsError("");
    setMechanicAssignments((current) =>
      current.map((mechanic) =>
        Number(mechanic.id) === Number(mechanicId)
          ? {
              ...mechanic,
              assignmentMode: isWorking ? "WORKING" : "FULL_OFF",
            }
          : mechanic,
      ),
    );
  };

  const handleMechanicPartialChange = (mechanicId, isPartialOff) => {
    setMechanicsError("");
    setMechanicAssignments((current) =>
      current.map((mechanic) =>
        Number(mechanic.id) === Number(mechanicId)
          ? {
              ...mechanic,
              assignmentMode: isPartialOff ? "PART_OFF" : "WORKING",
              partTime: mechanic.partTime || "12:00",
            }
          : mechanic,
      ),
    );
  };

  const handleMechanicPartFieldChange = (mechanicId, fieldName, value) => {
    setMechanicsError("");
    setMechanicAssignments((current) =>
      current.map((mechanic) =>
        Number(mechanic.id) === Number(mechanicId)
          ? { ...mechanic, [fieldName]: value }
          : mechanic,
      ),
    );
  };

  const handleSaveMechanics = async () => {
    if (selectedDateIsSunday) return;
    setCreateError("");
    setCreateSuccess("");
    setMechanicsError("");

    const details = [];
    const assignments = mechanicAssignments.map((mechanic) => {
      const assignmentMode = ["WORKING", "FULL_OFF", "PART_OFF"].includes(
        mechanic.assignmentMode,
      )
        ? mechanic.assignmentMode
        : "WORKING";

      if (assignmentMode === "PART_OFF") {
        const normalizedTime = String(mechanic.partTime || "").trim();
        const jobsDropped = Number(mechanic.jobsDropped);
        if (!normalizedTime) {
          details.push(
            `${mechanic.name || `Mechanic #${mechanic.id}`}: partial day requires a time`,
          );
        }
        if (!Number.isInteger(jobsDropped) || jobsDropped < 0) {
          details.push(
            `${mechanic.name || `Mechanic #${mechanic.id}`}: slots dropped must be a whole number 0 or greater`,
          );
        }

        return {
          mechanicId: Number(mechanic.id),
          status: assignmentMode,
          time: normalizedTime,
          jobsDropped: Number.isInteger(jobsDropped) ? jobsDropped : 0,
        };
      }

      return {
        mechanicId: Number(mechanic.id),
        status: assignmentMode,
      };
    });

    if (details.length > 0) {
      setMechanicsError(details.join(" "));
      return;
    }

    setIsMechanicsSaving(true);

    try {
      await axios.put(
        "/schedule/day/mechanics",
        { assignments },
        { params: { date: toDateKey(selectedDate) } },
      );
      setIsMechanicsModalOpen(false);
      setMechanicAssignments([]);
      setCreateSuccess("Mechanic assignments updated.");
      setRefreshKey((current) => current + 1);
    } catch (saveError) {
      setMechanicsError(
        getApiErrorMessage(saveError, "Could not save mechanic assignments."),
      );
    } finally {
      setIsMechanicsSaving(false);
    }
  };

  const loadAppointmentIntoForm = (appointment) => {
    const loadedForm = getAppointmentFormFromRecord(appointment);
    const slotsRequired = Math.max(1, Number(loadedForm.slotsRequired || 1));
    const shouldOpenAdvanced =
      loadedForm.isFirstJob ||
      loadedForm.isCapacityOverride ||
      loadedForm.isWaitLimitOverride ||
      slotsRequired !== 1;

    setEditingAppointmentId(Number(appointment.id));
    setCreateError("");
    setCreateSuccess("");
    setNewAppointment(loadedForm);
    setShowAdvancedCreateFields(shouldOpenAdvanced);
    setIsCreateFormOpen(true);
  };

  const handleCreateFieldChange = (event) => {
    const { name, value, type, checked } = event.target;

    setCreateError("");
    setCreateSuccess("");

    setNewAppointment((current) => {
      if (name === "kind") {
        const keepPriorityTime = ["WAIT", "DUE_BY"].includes(value);
        return {
          ...current,
          kind: value,
          priorityTime: keepPriorityTime ? current.priorityTime : "",
          isWaitLimitOverride: keepPriorityTime
            ? current.isWaitLimitOverride
            : false,
        };
      }

      return {
        ...current,
        [name]: type === "checkbox" ? checked : value,
      };
    });
  };

  const handleSaveAppointment = async (event) => {
    event.preventDefault();
    if (selectedDateIsSunday) return;
    if (!isEditingAppointment && (!hasActiveCreateLock || isCreateLocking)) {
      setCreateError("Please wait for the slot hold to finish updating.");
      return;
    }

    setIsCreateSubmitting(true);
    setCreateError("");
    setCreateSuccess("");

    try {
      const scheduledDateForSave =
        newAppointment.scheduledDate || toDateKey(selectedDate);
      const payloadBase = {
        scheduledDate: scheduledDateForSave,
        lname: newAppointment.lname.trim(),
        vehicle: newAppointment.vehicle.trim(),
        phone: newAppointment.phone.trim(),
        services: newAppointment.services.trim(),
        kind: newAppointment.kind,
        isFirstJob: Boolean(newAppointment.isFirstJob),
        slotsRequired: Math.max(1, Number(newAppointment.slotsRequired || 1)),
        isCapacityOverride: Boolean(newAppointment.isCapacityOverride),
        isWaitLimitOverride: Boolean(newAppointment.isWaitLimitOverride),
      };

      if (isEditingAppointment) {
        await axios.put(`/appointments/${editingAppointmentId}`, {
          ...payloadBase,
          priorityTime: needsPriorityTime ? newAppointment.priorityTime : null,
        });
        setCreateSuccess("Appointment updated.");
      } else {
        await axios.post("/appointments", {
          ...payloadBase,
          draftLockToken: createLock?.token,
          ...(needsPriorityTime
            ? { priorityTime: newAppointment.priorityTime }
            : {}),
        });
        setCreateSuccess("Appointment created.");
      }

      setIsCreateFormOpen(false);
      setEditingAppointmentId(null);
      setCreateLock(null);
      setIsCreateLocking(false);
      resetCreateForm();
      setRefreshKey((current) => current + 1);
    } catch (createRequestError) {
      setCreateError(
        getApiErrorMessage(
          createRequestError,
          "Could not create appointment for this day.",
        ),
      );
    } finally {
      setIsCreateSubmitting(false);
    }
  };

  const handleDeleteAppointment = async (appointment) => {
    const appointmentId = Number(appointment?.id);
    if (!Number.isInteger(appointmentId)) return;

    const customerName = appointment?.lname ? ` for ${appointment.lname}` : "";
    const confirmed = window.confirm(
      `Delete appointment${customerName} on ${selectedDate.toLocaleDateString()}? This cannot be undone.`,
    );
    if (!confirmed) return;

    setDeletingAppointmentId(appointmentId);
    setCreateError("");
    setCreateSuccess("");

    try {
      await axios.delete(`/appointments/${appointmentId}`);

      if (isEditingAppointment && editingAppointmentId === appointmentId) {
        closeAppointmentForm();
      }

      setCreateSuccess("Appointment deleted.");
      setRefreshKey((current) => current + 1);
    } catch (deleteRequestError) {
      setCreateError(
        getApiErrorMessage(
          deleteRequestError,
          "Could not delete appointment for this day.",
        ),
      );
    } finally {
      setDeletingAppointmentId(null);
    }
  };

  const handleUpdateAppointmentStatus = async (appointment, nextStatus) => {
    const appointmentId = Number(appointment?.id);
    if (!Number.isInteger(appointmentId)) return;

    const currentStatus = normalizeAppointmentStatus(appointment?.status);
    const normalizedNextStatus = normalizeAppointmentStatus(nextStatus);
    if (currentStatus === normalizedNextStatus) return;

    setStatusUpdatingAppointmentId(appointmentId);
    setCreateError("");
    setCreateSuccess("");

    try {
      await axios.put(`/appointments/${appointmentId}`, {
        status: normalizedNextStatus,
      });
      setCreateSuccess(
        `Status updated: ${getAppointmentStatusLabel(normalizedNextStatus)}.`,
      );
      setRefreshKey((current) => current + 1);
    } catch (statusUpdateError) {
      setCreateError(
        getApiErrorMessage(
          statusUpdateError,
          "Could not update appointment status.",
        ),
      );
    } finally {
      setStatusUpdatingAppointmentId(null);
    }
  };

  const addQuickService = (service) => {
    setNewAppointment((current) => {
      const prefix = current.services ? ", " : "";
      return {
        ...current,
        services: `${current.services}${prefix}${service}`,
      };
    });
  };

  useEffect(() => {
    if (!shouldManageCreateLock) return;

    let cancelled = false;

    const syncCreateLock = async () => {
      setIsCreateLocking(true);
      try {
        const response = createLock?.token
          ? await axios.put(`/appointment-locks/${createLock.token}`, createLockPayload)
          : await axios.post("/appointment-locks", createLockPayload);
        if (cancelled) return;

        setCreateLock(response.data?.lock || null);
        setCreateError("");
      } catch (lockError) {
        if (cancelled) return;
        if (
          createLock?.token &&
          lockError?.response?.data?.error === "LOCK_NOT_FOUND"
        ) {
          setCreateLock(null);
          setCreateError("Your temporary slot hold expired. Reacquiring...");
          return;
        }

        setCreateLock(null);
        setCreateError(
          getApiErrorMessage(
            lockError,
            "Could not reserve a slot while this form is open.",
          ),
        );
      } finally {
        if (!cancelled) setIsCreateLocking(false);
      }
    };

    void syncCreateLock();

    return () => {
      cancelled = true;
    };
  }, [createLock?.token, createLockPayload, shouldManageCreateLock]);

  useEffect(() => {
    if (!shouldManageCreateLock || !createLock?.token) return;

    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void axios
        .put(`/appointment-locks/${createLock.token}`, {})
        .then((response) => {
          if (cancelled) return;
          setCreateLock(response.data?.lock || null);
        })
        .catch((lockError) => {
          if (cancelled) return;
          if (lockError?.response?.data?.error === "LOCK_NOT_FOUND") {
            setCreateLock(null);
            setCreateError("Your temporary slot hold expired. Reacquiring...");
          }
        });
    }, LOCK_HEARTBEAT_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [createLock?.token, shouldManageCreateLock]);

  useEffect(() => {
    if (shouldManageCreateLock || !createLock?.token) return;
    const tokenToRelease = createLock.token;
    setCreateLock(null);
    setIsCreateLocking(false);
    void axios.delete(`/appointment-locks/${tokenToRelease}`).catch(() => {});
  }, [createLock?.token, shouldManageCreateLock]);

  return (
    <div className="users-page">
      <div className="sidebar">
        <h1>Appointment Availability Calendar</h1>
        <p className="calendar-subtitle">
          Sundays are disabled. Past dates remain selectable so appointments can
          be reviewed and updated. Future availability shifts from green (more
          open slots) to red (fewer open slots).
        </p>

        <div className="calendar-legend">
          <span className="legend-item legend-high">High availability</span>
          <span className="legend-item legend-medium">Medium</span>
          <span className="legend-item legend-low">Low / Full</span>
        </div>

        {error ? (
          <p className="calendar-status calendar-error">{error}</p>
        ) : (
          <p className="calendar-status calendar-loading">
            {isLoading ? "Loading availability..." : " "}
          </p>
        )}

        <div className="availability-mode-toggle" role="radiogroup">
          <label
            className={`availability-mode-option ${
              !isWaitMode ? "availability-mode-option--active" : ""
            }`}
          >
            <input
              type="radio"
              name="availabilityMode"
              checked={!isWaitMode}
              onChange={() => setAvailabilityMode("slots")}
            />
            Total slots
          </label>
          <label
            className={`availability-mode-option ${
              isWaitMode ? "availability-mode-option--active" : ""
            }`}
          >
            <input
              type="radio"
              name="availabilityMode"
              checked={isWaitMode}
              onChange={() => setAvailabilityMode("wait")}
            />
            Waiters
          </label>
        </div>
        <p className="availability-mode-caption">
          Showing{" "}
          {isWaitMode
            ? "wait/due-by spots remaining on each day."
            : "total appointment slots remaining on each day."}
        </p>

        <Calendar
          className="availability-calendar"
          value={selectedDate}
          calendarType="gregory"
          onChange={(value) => {
            const nextDate = Array.isArray(value) ? value[0] : value;
            if (nextDate) setSelectedDate(normalizeDate(nextDate));
          }}
          onActiveStartDateChange={({
            activeStartDate: nextStartDate,
            view,
          }) => {
            if (view === "month" && nextStartDate) {
              setActiveStartDate(normalizeDate(nextStartDate));
            }
          }}
          tileDisabled={({ date, view }) =>
            view === "month" && isCalendarDisabledDay(date)
          }
          tileClassName={({ date, view }) => {
            if (view !== "month") return null;
            if (isPastOrSunday(date))
              return "calendar-tile calendar-tile--past";

            const day = availabilityByDate[toDateKey(date)];
            const bucket = getAvailabilityBucket(
              day,
              isWaitMode ? "wait" : "slots",
            );
            return `calendar-tile calendar-tile--availability-${bucket}`;
          }}
          tileContent={({ date, view }) => {
            if (view !== "month" || isPastOrSunday(date)) return null;
            const day = availabilityByDate[toDateKey(date)];
            if (!day) return null;

            const remaining = isWaitMode
              ? Math.max(0, Number(day.effectiveWaitRemaining ?? day.waitRemaining ?? 0))
              : Math.max(
                  0,
                  Number(day.effectiveRemainingSlots ?? day.remainingSlots ?? 0),
                );
            return (
              <span className="calendar-openings">
                {remaining} {isWaitMode ? "wait open" : "open"}
              </span>
            );
          }}
        />
      </div>
      <div>
        {selectedDayData && !selectedDateIsSunday ? (
          <div className="selected-day-summary">
            <div className="selected-day-summary-header">
              <h2>
                {selectedDate.toLocaleDateString(undefined, {
                  weekday: "long",
                  year: "numeric",
                  month: "numeric",
                  day: "numeric",
                })}
              </h2>
              <div className="selected-day-summary-actions">
                <button
                  type="button"
                  className="summary-action-button"
                  onClick={() => {
                    if (isMechanicsModalOpen) {
                      closeMechanicsModal();
                    } else {
                      openMechanicsModal();
                    }
                  }}
                >
                  {isMechanicsModalOpen ? "Close mechanics" : "Edit mechanics"}
                </button>
                {canCreateForSelectedDate || isEditingAppointment ? (
                  <button
                    type="button"
                    className="summary-action-button"
                    onClick={() => {
                      if (isCreateFormOpen) {
                        closeAppointmentForm();
                      } else {
                        openNewAppointmentForm();
                      }
                    }}
                  >
                    {isCreateFormOpen
                      ? isEditingAppointment
                        ? "Cancel edit"
                        : "Cancel"
                      : "New appointment"}
                  </button>
                ) : null}
              </div>
            </div>
            {createSuccess ? (
              <p className="create-status create-status-success">
                {createSuccess}
              </p>
            ) : null}
            <p>{selectedRemaining} appointment slot(s) available</p>
            <p>
              {selectedUsed} used / {selectedCapacity} total capacity
            </p>
            <p>
              {selectedWaitUsed} used / {selectedWaitLimit} waiters allowed (
              {selectedWaitRemaining} open)
            </p>
            {Number(selectedDayData?.draftLockCount || 0) > 0 ? (
              <p>{Number(selectedDayData?.draftLockCount || 0)} temporary hold(s) active</p>
            ) : null}
          </div>
        ) : null}

        {isCreateFormOpen && !selectedDateIsSunday ? (
          <div className="appointment-create-panel">
            <h3>
              {isEditingAppointment
                ? "Update appointment for "
                : "New appointment for "}
              {selectedDate.toLocaleDateString(undefined, {
                weekday: "long",
                year: "numeric",
                month: "numeric",
                day: "numeric",
              })}
            </h3>
            {!isEditingAppointment ? (
              <p
                className={`create-status ${
                  hasActiveCreateLock ? "create-status-info" : "create-status-warning"
                }`}
              >
                {isCreateLocking
                  ? "Reserving slot..."
                  : hasActiveCreateLock
                    ? "Slot reserved while this form is open."
                    : "No slot hold yet. Update details to reserve a slot."}
              </p>
            ) : null}

            <form
              className="appointment-create-form"
              onSubmit={handleSaveAppointment}
            >
              <label htmlFor="create-lname">Last name</label>
              <input
                id="create-lname"
                type="text"
                name="lname"
                value={newAppointment.lname}
                onChange={handleCreateFieldChange}
                required
              />

              <label htmlFor="create-phone">Phone</label>
              <input
                id="create-phone"
                type="tel"
                name="phone"
                value={newAppointment.phone}
                onChange={handleCreateFieldChange}
                required
              />

              <label htmlFor="create-vehicle">Vehicle</label>
              <input
                id="create-vehicle"
                type="text"
                name="vehicle"
                value={newAppointment.vehicle}
                onChange={handleCreateFieldChange}
                required
              />

              <label htmlFor="create-services">Services</label>
              <div className="services-field">
                <textarea
                  id="create-services"
                  name="services"
                  value={newAppointment.services}
                  onChange={handleCreateFieldChange}
                  rows={3}
                  required
                />
                <div className="services-quickAdd">
                  {newAppointment.services.includes("State Inspection") ? (
                    ""
                  ) : (
                    <button
                      type="button"
                      onClick={() => addQuickService("State Inspection")}
                    >
                      + State Inspection
                    </button>
                  )}
                  {newAppointment.services.includes("Emissions Inspection") ? (
                    ""
                  ) : (
                    <button
                      type="button"
                      onClick={() => addQuickService("Emissions Inspection")}
                    >
                      + Emissions Inspection
                    </button>
                  )}
                  {newAppointment.services.includes("Oil Change") ? (
                    ""
                  ) : (
                    <button type="button" onClick={() => addQuickService("Oil Change")}>
                      + Oil Change
                    </button>
                  )}
                  {newAppointment.services.includes("Tire Rotation") ? (
                    ""
                  ) : (
                    <button
                      type="button"
                      onClick={() => addQuickService("Tire Rotation")}
                    >
                      + Tire Rotation
                    </button>
                  )}
                </div>
              </div>

              <fieldset className="kind-fieldset">
                <legend>Appointment type</legend>
                <label className="kind-option">
                  <input
                    type="radio"
                    name="kind"
                    value="DROPOFF"
                    checked={newAppointment.kind === "DROPOFF"}
                    onChange={handleCreateFieldChange}
                  />
                  Dropoff
                </label>
                <label className="kind-option">
                  <input
                    type="radio"
                    name="kind"
                    value="WAIT"
                    checked={newAppointment.kind === "WAIT"}
                    onChange={handleCreateFieldChange}
                  />
                  Wait
                </label>
                <label className="kind-option">
                  <input
                    type="radio"
                    name="kind"
                    value="DUE_BY"
                    checked={newAppointment.kind === "DUE_BY"}
                    onChange={handleCreateFieldChange}
                  />
                  Due by
                </label>
              </fieldset>

              {needsPriorityTime ? (
                <>
                  <label htmlFor="create-priority-time">
                    {newAppointment.kind === "WAIT"
                      ? "Wait time"
                      : "Due-by time"}
                  </label>
                  <input
                    id="create-priority-time"
                    type="time"
                    name="priorityTime"
                    value={newAppointment.priorityTime}
                    onChange={handleCreateFieldChange}
                    required
                  />
                </>
              ) : null}

              <button
                type="button"
                className="toggle-advanced-button"
                onClick={() =>
                  setShowAdvancedCreateFields((current) => !current)
                }
              >
                {showAdvancedCreateFields
                  ? "Hide advanced options"
                  : "Show advanced options"}
              </button>

              {showAdvancedCreateFields ? (
                <div className="advanced-fields">
                  <label htmlFor="create-slots-required">Slots required</label>
                  <input
                    id="create-slots-required"
                    type="number"
                    min={1}
                    step={1}
                    name="slotsRequired"
                    value={newAppointment.slotsRequired}
                    onChange={handleCreateFieldChange}
                  />

                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      name="isFirstJob"
                      checked={newAppointment.isFirstJob}
                      onChange={handleCreateFieldChange}
                    />
                    First job
                  </label>

                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      name="isCapacityOverride"
                      checked={newAppointment.isCapacityOverride}
                      onChange={handleCreateFieldChange}
                    />
                    Capacity override
                  </label>

                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      name="isWaitLimitOverride"
                      checked={newAppointment.isWaitLimitOverride}
                      onChange={handleCreateFieldChange}
                      disabled={!needsPriorityTime}
                    />
                    Wait limit override
                  </label>

                  <label htmlFor="create-scheduled-date">
                    Appointment date
                  </label>
                  <input
                    id="create-scheduled-date"
                    type="date"
                    name="scheduledDate"
                    value={newAppointment.scheduledDate}
                    onChange={handleCreateFieldChange}
                    required
                  />
                </div>
              ) : null}

              {createError ? (
                <p className="create-status create-status-error">
                  {createError}
                </p>
              ) : null}

              <div className="create-form-actions">
                <button
                  type="submit"
                  disabled={
                    isCreateSubmitting ||
                    (!isEditingAppointment && (isCreateLocking || !hasActiveCreateLock))
                  }
                >
                  {isCreateSubmitting
                    ? isEditingAppointment
                      ? "Saving..."
                      : "Creating..."
                    : isEditingAppointment
                      ? "Save changes"
                      : "Create appointment"}
                </button>
              </div>
            </form>
          </div>
        ) : null}

        {!selectedDateIsSunday ? (
          <div className="selected-day-appointments">
            <h3>Appointments for {selectedDate.toLocaleDateString()}</h3>

            {dayError ? (
              <p className="day-details-status day-details-error">{dayError}</p>
            ) : isDayLoading ? (
              <p className="day-details-status day-details-loading">
                Loading appointments...
              </p>
            ) : selectedAppointments.length === 0 ? (
              <p className="day-details-status day-details-empty">
                No appointments scheduled for this day.
              </p>
            ) : (
              <ul className="appointment-list">
                {selectedAppointments.map((appointment) => {
                  const appointmentId = Number(appointment.id);
                  const kind = appointment.kind || "DROPOFF";
                  const isFirstJob = Number(appointment.isFirstJob) === 1;
                  const isCapacityOverride =
                    Number(appointment.isCapacityOverride) === 1;
                  const isWaitOverride =
                    Number(appointment.isWaitLimitOverride) === 1;
                  const appointmentStatus = normalizeAppointmentStatus(
                    appointment.status,
                  );
                  const statusIndex =
                    getAppointmentStatusStepIndex(appointmentStatus);
                  const statusProgressPercent =
                    APPOINTMENT_STATUS_STEPS.length <= 1
                      ? 0
                      : (statusIndex / (APPOINTMENT_STATUS_STEPS.length - 1)) *
                        100;
                  const isStatusUpdating =
                    statusUpdatingAppointmentId === appointmentId;
                  const isAppointmentBusy =
                    isStatusUpdating || deletingAppointmentId === appointmentId;

                  return (
                    <li key={appointment.id} className="appointment-item">
                      <div className="appointment-header">
                        <h4>{appointment.lname || "No Name"}</h4>
                        {isFirstJob ? (
                          <span
                            className={`appointment-kind appointment-kind--wait`}
                          >
                            First Job
                          </span>
                        ) : (
                          <span
                            className={`appointment-kind appointment-kind--${String(
                              kind,
                            ).toLowerCase()}`}
                          >
                            {kind}{" "}
                            {formatPriorityTime(appointment.priorityTime) ===
                            "N/A" ? (
                              ""
                            ) : (
                              <>
                                @ {formatPriorityTime(appointment.priorityTime)}
                              </>
                            )}
                          </span>
                        )}
                      </div>

                      <p>
                        <strong>Vehicle:</strong> {appointment.vehicle || "N/A"}
                      </p>
                      <p>
                        <strong>Phone:</strong> {appointment.phone || "N/A"}
                      </p>
                      <p>
                        <strong>Services:</strong>{" "}
                        {appointment.services || "N/A"}
                      </p>
                      <div className="appointment-status-section">
                        <p className="appointment-status-current">
                          <strong>Status:</strong>{" "}
                          {getAppointmentStatusLabel(appointmentStatus)}
                          {isStatusUpdating ? " (Saving...)" : ""}
                        </p>
                        <div
                          className="appointment-status-progress"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={APPOINTMENT_STATUS_STEPS.length - 1}
                          aria-valuenow={statusIndex}
                          aria-label={`Status for appointment ${appointmentId}`}
                        >
                          <span
                            className="appointment-status-progress-fill"
                            style={{ width: `${statusProgressPercent}%` }}
                          />
                        </div>
                        <div className="appointment-status-steps">
                          {APPOINTMENT_STATUS_STEPS.map(
                            (statusStep, stepIndex) => {
                              const isReached = stepIndex <= statusIndex;
                              const isCurrent =
                                statusStep.value === appointmentStatus;
                              return (
                                <button
                                  key={statusStep.value}
                                  type="button"
                                  className={`appointment-status-step ${
                                    isReached
                                      ? "appointment-status-step--reached"
                                      : ""
                                  } ${
                                    isCurrent
                                      ? "appointment-status-step--active"
                                      : ""
                                  }`}
                                  disabled={isAppointmentBusy}
                                  onClick={() =>
                                    handleUpdateAppointmentStatus(
                                      appointment,
                                      statusStep.value,
                                    )
                                  }
                                >
                                  {statusStep.short}
                                </button>
                              );
                            },
                          )}
                        </div>
                      </div>
                      {appointment.slotsRequired === 1 ? (
                        ""
                      ) : (
                        <p>
                          <strong>Slots:</strong>{" "}
                          {Math.max(0, Number(appointment.slotsRequired || 0))}
                          {isCapacityOverride ? " | Capacity override" : ""}
                          {isWaitOverride ? " | Wait override" : ""}
                        </p>
                      )}
                      <div className="appointment-item-actions">
                        <button
                          type="button"
                          className="appointment-item-action-button"
                          data-type="edit"
                          disabled={isAppointmentBusy}
                          onClick={() => loadAppointmentIntoForm(appointment)}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="appointment-item-action-button"
                          data-type="delete"
                          disabled={isAppointmentBusy}
                          onClick={() => handleDeleteAppointment(appointment)}
                        >
                          {deletingAppointmentId === appointmentId
                            ? "Deleting..."
                            : "🗙"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}

        {isMechanicsModalOpen ? (
          <div
            className="mechanics-modal-backdrop"
            role="presentation"
            onClick={closeMechanicsModal}
          >
            <div
              className="mechanics-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="mechanics-modal-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mechanics-modal-header">
                <h3 id="mechanics-modal-title">
                  Mechanics for{" "}
                  {selectedDate.toLocaleDateString(undefined, {
                    weekday: "long",
                    year: "numeric",
                    month: "numeric",
                    day: "numeric",
                  })}
                </h3>
              </div>
              <p className="mechanics-modal-caption">
                Check a mechanic to mark them working that day. Use Partial day
                off to set an off-time and how many appointment slots to drop.
              </p>

              {mechanicsError ? (
                <p className="create-status create-status-error">
                  {mechanicsError}
                </p>
              ) : null}

              {isMechanicsLoading ? (
                <p className="day-details-status day-details-loading">
                  Loading mechanics...
                </p>
              ) : mechanicAssignments.length === 0 ? (
                <p className="day-details-status day-details-empty">
                  No mechanics found.
                </p>
              ) : (
                <ul className="mechanics-checklist">
                  {mechanicAssignments.map((mechanic) => (
                    <li key={mechanic.id}>
                      <div className="mechanic-check-row">
                        <label className="mechanic-primary-toggle">
                          <input
                            type="checkbox"
                            checked={mechanic.assignmentMode !== "FULL_OFF"}
                            onChange={(event) =>
                              handleMechanicWorkingChange(
                                mechanic.id,
                                event.target.checked,
                              )
                            }
                            disabled={isMechanicsSaving}
                          />
                          <span className="mechanic-check-name">
                            {mechanic.name || `Mechanic #${mechanic.id}`}
                          </span>
                        </label>

                        {mechanic.assignmentMode !== "FULL_OFF" ? (
                          <label className="mechanic-partial-toggle">
                            <input
                              type="checkbox"
                              checked={mechanic.assignmentMode === "PART_OFF"}
                              onChange={(event) =>
                                handleMechanicPartialChange(
                                  mechanic.id,
                                  event.target.checked,
                                )
                              }
                              disabled={isMechanicsSaving}
                            />
                            Partial day off
                          </label>
                        ) : null}

                        {mechanic.assignmentMode === "PART_OFF" ? (
                          <div className="mechanic-partial-fields">
                            <label>
                              Time off starts
                              <input
                                type="time"
                                value={mechanic.partTime || ""}
                                onChange={(event) =>
                                  handleMechanicPartFieldChange(
                                    mechanic.id,
                                    "partTime",
                                    event.target.value,
                                  )
                                }
                                disabled={isMechanicsSaving}
                              />
                            </label>
                            <label>
                              Slots dropped
                              <input
                                type="number"
                                min={0}
                                step={1}
                                value={mechanic.jobsDropped || "0"}
                                onChange={(event) =>
                                  handleMechanicPartFieldChange(
                                    mechanic.id,
                                    "jobsDropped",
                                    event.target.value,
                                  )
                                }
                                disabled={isMechanicsSaving}
                              />
                            </label>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mechanics-modal-actions">
                <button
                  type="button"
                  className="summary-action-button"
                  onClick={closeMechanicsModal}
                  disabled={isMechanicsSaving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="summary-action-button mechanics-modal-save"
                  onClick={handleSaveMechanics}
                  disabled={isMechanicsSaving || isMechanicsLoading}
                >
                  {isMechanicsSaving ? "Saving..." : "Save assignments"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default Users;
