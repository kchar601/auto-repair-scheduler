import { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import "./Users.css";
import AppointmentList from "./components/users/AppointmentList";
import CalendarSidebar from "./components/users/CalendarSidebar";
import DailyAppointmentSearch from "./components/users/DailyAppointmentSearch";
import DailyPrintSheet from "./components/users/DailyPrintSheet";
import DaySummaryCard from "./components/users/DaySummaryCard";
import {
  getApiErrorMessage,
  getAppointmentFormFromRecord,
  getAppointmentStatusLabel,
  getDefaultPartialTime,
  getInitialAppointmentForm,
  getMechanicAssignmentMode,
  normalizeAppointmentStatus,
  normalizeDate,
  toDateKey,
} from "./usersUtils";

const LOCK_HEARTBEAT_MS = 25000;

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
  const [globalSearchTerm, setGlobalSearchTerm] = useState("");
  const [globalSearchResults, setGlobalSearchResults] = useState([]);
  const [isGlobalSearchLoading, setIsGlobalSearchLoading] = useState(false);
  const [globalSearchError, setGlobalSearchError] = useState("");
  const [queuedVehicles, setQueuedVehicles] = useState([]);
  const [isQueuedVehiclesLoading, setIsQueuedVehiclesLoading] = useState(false);
  const [queuedVehiclesError, setQueuedVehiclesError] = useState("");
  const [queuedVehiclesRefreshKey, setQueuedVehiclesRefreshKey] = useState(0);
  const [dailySearchTerm, setDailySearchTerm] = useState("");
  const [focusedAppointmentId, setFocusedAppointmentId] = useState(null);
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

  const applyAppointmentStatusLocally = useCallback(
    (appointmentId, nextStatus) => {
      const normalizedStatus = normalizeAppointmentStatus(nextStatus);
      setDayDetails((current) => {
        if (!current || !Array.isArray(current.appointments)) return current;

        let changed = false;
        const nextAppointments = current.appointments.map((appointment) => {
          if (Number(appointment?.id) !== appointmentId) return appointment;
          if (
            normalizeAppointmentStatus(appointment?.status) === normalizedStatus
          )
            return appointment;

          changed = true;
          return {
            ...appointment,
            status: normalizedStatus,
          };
        });

        if (!changed) return current;
        return {
          ...current,
          appointments: nextAppointments,
        };
      });
    },
    [],
  );

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
    const handleScheduleChange = (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event?.data || "{}");
      } catch {
        payload = null;
      }

      if (payload?.reason === "appointment_status_updated") {
        const appointmentId = Number(payload.appointmentId);
        if (Number.isInteger(appointmentId)) {
          applyAppointmentStatusLocally(appointmentId, payload.status);
        }
        setQueuedVehiclesRefreshKey((current) => current + 1);
        return;
      }

      setRefreshKey((current) => current + 1);
    };

    source.addEventListener("schedule.changed", handleScheduleChange);
    source.onerror = () => {};

    return () => {
      source.removeEventListener("schedule.changed", handleScheduleChange);
      source.close();
    };
  }, [applyAppointmentStatusLocally]);

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
    setDailySearchTerm("");
    setShowAdvancedCreateFields(false);
    setNewAppointment(getInitialAppointmentForm(toDateKey(selectedDate)));
  }, [selectedDate]);

  useEffect(() => {
    const query = globalSearchTerm.trim();
    if (!query) {
      setGlobalSearchResults([]);
      setGlobalSearchError("");
      setIsGlobalSearchLoading(false);
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(async () => {
      setIsGlobalSearchLoading(true);
      setGlobalSearchError("");
      try {
        const response = await axios.get("/appointments/search", {
          params: { q: query, limit: 120 },
        });
        if (cancelled) return;
        setGlobalSearchResults(response.data?.appointments || []);
      } catch (searchError) {
        if (cancelled) return;
        setGlobalSearchResults([]);
        setGlobalSearchError(
          getApiErrorMessage(searchError, "Could not search appointments."),
        );
      } finally {
        if (!cancelled) setIsGlobalSearchLoading(false);
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [globalSearchTerm]);

  useEffect(() => {
    const excludeDate = toDateKey(selectedDate);
    let cancelled = false;

    const loadQueuedVehicles = async () => {
      setIsQueuedVehiclesLoading(true);
      setQueuedVehiclesError("");
      try {
        const response = await axios.get("/appointments/queued", {
          params: { excludeDate, limit: 80 },
        });
        if (cancelled) return;
        setQueuedVehicles(response.data?.appointments || []);
      } catch (queuedError) {
        if (cancelled) return;
        setQueuedVehicles([]);
        setQueuedVehiclesError(
          getApiErrorMessage(
            queuedError,
            "Could not load queued off-day vehicles.",
          ),
        );
      } finally {
        if (!cancelled) setIsQueuedVehiclesLoading(false);
      }
    };

    void loadQueuedVehicles();

    return () => {
      cancelled = true;
    };
  }, [selectedDate, refreshKey, queuedVehiclesRefreshKey]);

  useEffect(() => {
    if (!Number.isInteger(focusedAppointmentId)) return;

    const target = document.querySelector(
      `[data-appointment-id="${focusedAppointmentId}"]`,
    );
    if (!target) return;

    target.scrollIntoView({ behavior: "smooth", block: "center" });
    const timeoutId = window.setTimeout(() => {
      setFocusedAppointmentId((current) =>
        current === focusedAppointmentId ? null : current,
      );
    }, 6000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [focusedAppointmentId, dayDetails]);

  const selectedDayData =
    dayDetails?.summary || availabilityByDate[toDateKey(selectedDate)];
  const selectedRemaining = Math.max(
    0,
    Number(
      selectedDayData?.effectiveRemainingSlots ??
        selectedDayData?.remainingSlots ??
        0,
    ),
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
      selectedDayData?.effectiveWaitRemaining ??
        selectedDayData?.waitRemaining ??
        0,
    ),
  );
  const isWaitMode = availabilityMode === "wait";
  const selectedDateIsPastDay = isPastDay(selectedDate);
  const selectedDateIsSunday = isSunday(selectedDate);
  const selectedDateLongLabel = selectedDate.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const selectedDateShortLabel = selectedDate.toLocaleDateString();
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
  const normalizedDailySearchTerm = dailySearchTerm.trim().toLowerCase();
  const isDailySearchActive = normalizedDailySearchTerm.length > 0;
  const globalSearchGroups = useMemo(() => {
    const byLastName = new Map();
    for (const appointment of globalSearchResults) {
      const lname = String(appointment?.lname || "No Name").trim() || "No Name";
      if (!byLastName.has(lname)) {
        byLastName.set(lname, []);
      }
      byLastName.get(lname).push(appointment);
    }

    return Array.from(byLastName.entries()).map(([lname, appointments]) => ({
      lname,
      appointments,
    }));
  }, [globalSearchResults]);

  const handleFocusAppointment = useCallback((appointment) => {
    const appointmentId = Number(appointment?.id);
    if (!Number.isInteger(appointmentId)) return;

    const nextDate = normalizeDate(
      new Date(`${String(appointment?.scheduledDate || "")}T00:00:00`),
    );
    if (Number.isFinite(nextDate.getTime())) {
      setSelectedDate(nextDate);
    }

    setFocusedAppointmentId(appointmentId);
  }, []);

  const handleSelectGlobalSearchResult = useCallback(
    (appointment) => {
      handleFocusAppointment(appointment);
      setGlobalSearchTerm("");
      setGlobalSearchResults([]);
      setGlobalSearchError("");
    },
    [handleFocusAppointment],
  );

  const handleSelectDailySearchResult = useCallback(
    (appointment) => {
      handleFocusAppointment(appointment);
      const lname = String(appointment?.lname || "").trim();
      if (lname) setDailySearchTerm(lname);
    },
    [handleFocusAppointment],
  );

  const handleSelectQueuedVehicle = useCallback(
    (appointment) => {
      handleFocusAppointment(appointment);
    },
    [handleFocusAppointment],
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

  const handlePrintDailyAppointments = () => {
    window.print();
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
    applyAppointmentStatusLocally(appointmentId, normalizedNextStatus);

    try {
      await axios.put(`/appointments/${appointmentId}`, {
        status: normalizedNextStatus,
      });
      setCreateSuccess(
        `Status updated: ${getAppointmentStatusLabel(normalizedNextStatus)}.`,
      );
    } catch (statusUpdateError) {
      applyAppointmentStatusLocally(appointmentId, currentStatus);
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
          ? await axios.put(
              `/appointment-locks/${createLock.token}`,
              createLockPayload,
            )
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

  const printAppointments = useMemo(() => {
    if (!Array.isArray(selectedAppointments) || selectedAppointments.length < 2)
      return selectedAppointments;

    const getKindRank = (appointment) => {
      const kind = String(appointment?.kind || "DROPOFF")
        .trim()
        .toUpperCase();
      if (kind === "WAIT") return 0;
      if (kind === "DUE_BY") return 1;
      return 2;
    };

    return [...selectedAppointments].sort((left, right) => {
      const leftIsReady =
        normalizeAppointmentStatus(left?.status) === "READY_FOR_PICKUP";
      const rightIsReady =
        normalizeAppointmentStatus(right?.status) === "READY_FOR_PICKUP";
      if (leftIsReady !== rightIsReady) return leftIsReady ? 1 : -1;

      const leftKindRank = getKindRank(left);
      const rightKindRank = getKindRank(right);
      if (leftKindRank !== rightKindRank) {
        return leftKindRank - rightKindRank;
      }

      if (leftKindRank === 2) {
        const leftName = String(left?.lname || "").trim();
        const rightName = String(right?.lname || "").trim();
        const nameCompare = leftName.localeCompare(rightName, undefined, {
          sensitivity: "base",
        });
        if (nameCompare !== 0) return nameCompare;
      }

      return Number(left?.id || 0) - Number(right?.id || 0);
    });
  }, [selectedAppointments]);
  const dailySearchMatches = useMemo(() => {
    if (!isDailySearchActive) return [];

    return printAppointments.filter((appointment) =>
      String(appointment?.lname || "")
        .trim()
        .toLowerCase()
        .includes(normalizedDailySearchTerm),
    );
  }, [isDailySearchActive, normalizedDailySearchTerm, printAppointments]);

  return (
    <div className="users-page">
      <CalendarSidebar
        selectedDate={selectedDate}
        setSelectedDate={setSelectedDate}
        setActiveStartDate={setActiveStartDate}
        availabilityByDate={availabilityByDate}
        isWaitMode={isWaitMode}
        setAvailabilityMode={setAvailabilityMode}
        error={error}
        isLoading={isLoading}
        isPastOrSunday={isPastOrSunday}
        isCalendarDisabledDay={isCalendarDisabledDay}
        globalSearchTerm={globalSearchTerm}
        setGlobalSearchTerm={setGlobalSearchTerm}
        isGlobalSearchLoading={isGlobalSearchLoading}
        globalSearchError={globalSearchError}
        globalSearchGroups={globalSearchGroups}
        onSelectGlobalSearchResult={handleSelectGlobalSearchResult}
        queuedVehicles={queuedVehicles}
        isQueuedVehiclesLoading={isQueuedVehiclesLoading}
        queuedVehiclesError={queuedVehiclesError}
        onSelectQueuedVehicle={handleSelectQueuedVehicle}
      />
      <div className="day-details-pane">
        {selectedDayData && !selectedDateIsSunday ? (
          <DaySummaryCard
            selectedDayData={selectedDayData}
            selectedDateLongLabel={selectedDateLongLabel}
            isMechanicsModalOpen={isMechanicsModalOpen}
            closeMechanicsModal={closeMechanicsModal}
            openMechanicsModal={openMechanicsModal}
            handlePrintDailyAppointments={handlePrintDailyAppointments}
            canCreateForSelectedDate={canCreateForSelectedDate}
            isEditingAppointment={isEditingAppointment}
            isCreateFormOpen={isCreateFormOpen}
            closeAppointmentForm={closeAppointmentForm}
            openNewAppointmentForm={openNewAppointmentForm}
            createSuccess={createSuccess}
            selectedRemaining={selectedRemaining}
            selectedUsed={selectedUsed}
            selectedCapacity={selectedCapacity}
            selectedWaitUsed={selectedWaitUsed}
            selectedWaitLimit={selectedWaitLimit}
            selectedWaitRemaining={selectedWaitRemaining}
          />
        ) : null}

        {isCreateFormOpen && !selectedDateIsSunday ? (
          <div className="appointment-create-panel">
            <h3>
              {isEditingAppointment
                ? "Update appointment for "
                : "New appointment for "}
              {selectedDateLongLabel}
            </h3>
            {!isEditingAppointment ? (
              <p
                className={`create-status ${
                  hasActiveCreateLock
                    ? "create-status-info"
                    : "create-status-warning"
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
                    <button
                      type="button"
                      onClick={() => addQuickService("Oil Change")}
                    >
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
                    (!isEditingAppointment &&
                      (isCreateLocking || !hasActiveCreateLock))
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
            <h3>Appointments for {selectedDateShortLabel}</h3>
            <DailyAppointmentSearch
              dailySearchTerm={dailySearchTerm}
              setDailySearchTerm={setDailySearchTerm}
              isDailySearchActive={isDailySearchActive}
              dailySearchMatches={dailySearchMatches}
              onSelectDailySearchResult={handleSelectDailySearchResult}
            />

            <AppointmentList
              dayError={dayError}
              isDayLoading={isDayLoading}
              appointments={printAppointments}
              isDailySearchActive={isDailySearchActive}
              normalizedDailySearchTerm={normalizedDailySearchTerm}
              focusedAppointmentId={focusedAppointmentId}
              statusUpdatingAppointmentId={statusUpdatingAppointmentId}
              deletingAppointmentId={deletingAppointmentId}
              onStatusUpdate={handleUpdateAppointmentStatus}
              onEdit={loadAppointmentIntoForm}
              onDelete={handleDeleteAppointment}
            />
          </div>
        ) : null}

        {!selectedDateIsSunday ? (
          <DailyPrintSheet
            dayError={dayError}
            isDayLoading={isDayLoading}
            printAppointments={printAppointments}
            selectedDateLongLabel={selectedDateLongLabel}
          />
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

