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

function getAvailabilityBucket(day) {
  if (!day) return "unknown";
  const capacity = Number(day.capacitySlots || 0);
  const remaining = Math.max(0, Number(day.remainingSlots || 0));

  if (capacity <= 0) return "0";

  const ratio = remaining / capacity;
  if (ratio >= 0.8) return "4";
  if (ratio >= 0.6) return "3";
  if (ratio >= 0.4) return "2";
  if (ratio >= 0.2) return "1";
  return "0";
}

function formatPriorityTime(value) {
  if (!value) return "N/A";
  const [hoursPart, minutesPart] = String(value).split(":");
  const hours = Number(hoursPart);
  if (!Number.isFinite(hours) || !minutesPart) return String(value);

  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${minutesPart} ${suffix}`;
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

  const today = useMemo(() => normalizeDate(new Date()), []);

  const isPastDay = (date) => normalizeDate(date) < today;

  const isSunday = (date) => normalizeDate(date).getDay() === 0;
  const isNonWorkingDay = (date) => isPastDay(date) || isSunday(date);

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
  }, [activeStartDate]);

  useEffect(() => {
    let cancelled = false;

    const loadDayDetails = async () => {
      const normalizedSelectedDate = normalizeDate(selectedDate);
      if (
        normalizedSelectedDate < today ||
        normalizedSelectedDate.getDay() === 0
      ) {
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
  }, [selectedDate, today]);

  const selectedDayData =
    dayDetails?.summary || availabilityByDate[toDateKey(selectedDate)];
  const selectedRemaining = Math.max(
    0,
    Number(selectedDayData?.remainingSlots || 0),
  );
  const selectedCapacity = Number(selectedDayData?.capacitySlots || 0);
  const selectedUsed = Number(selectedDayData?.usedSlots || 0);
  const selectedAppointments = dayDetails?.appointments || [];

  return (
    <div className="users-page">
      <div className="sidebar">
        <h1>Appointment Availability Calendar</h1>
        <p className="calendar-subtitle">
          Past days and Sundays are disabled. Future availability shifts from
          green (more open slots) to red (fewer open slots). Click any available
          day to see its appointments.
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
      </div>

      <Calendar
        className="availability-calendar"
        value={selectedDate}
        onChange={(value) => {
          const nextDate = Array.isArray(value) ? value[0] : value;
          if (nextDate) setSelectedDate(normalizeDate(nextDate));
        }}
        onActiveStartDateChange={({ activeStartDate: nextStartDate, view }) => {
          if (view === "month" && nextStartDate) {
            setActiveStartDate(normalizeDate(nextStartDate));
          }
        }}
        tileDisabled={({ date, view }) =>
          view === "month" && isNonWorkingDay(date)
        }
        tileClassName={({ date, view }) => {
          if (view !== "month") return null;
          if (isNonWorkingDay(date)) return "calendar-tile calendar-tile--past";

          const day = availabilityByDate[toDateKey(date)];
          const bucket = getAvailabilityBucket(day);
          return `calendar-tile calendar-tile--availability-${bucket}`;
        }}
        tileContent={({ date, view }) => {
          if (view !== "month" || isNonWorkingDay(date)) return null;
          const day = availabilityByDate[toDateKey(date)];
          if (!day) return null;

          const remaining = Math.max(0, Number(day.remainingSlots || 0));
          return <span className="calendar-openings">{remaining} open</span>;
        }}
      />

      {selectedDayData && !isNonWorkingDay(selectedDate) ? (
        <div className="selected-day-summary">
          <h2>{selectedDate.toLocaleDateString()}</h2>
          <p>{selectedRemaining} appointment slot(s) available</p>
          <p>
            {selectedUsed} used / {selectedCapacity} total capacity
          </p>
        </div>
      ) : null}

      {!isNonWorkingDay(selectedDate) ? (
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
                const kind = appointment.kind || "DROPOFF";
                const isFirstJob = Number(appointment.isFirstJob) === 1;
                const isCapacityOverride =
                  Number(appointment.isCapacityOverride) === 1;
                const isWaitOverride =
                  Number(appointment.isWaitLimitOverride) === 1;

                return (
                  <li key={appointment.id} className="appointment-item">
                    <div className="appointment-header">
                      <h4>{appointment.lname || "No Name"}</h4>
                      <span
                        className={`appointment-kind appointment-kind--${String(
                          kind,
                        ).toLowerCase()}`}
                      >
                        {kind}
                      </span>
                    </div>

                    <p>
                      <strong>Vehicle:</strong> {appointment.vehicle || "N/A"}
                    </p>
                    <p>
                      <strong>Phone:</strong> {appointment.phone || "N/A"}
                    </p>
                    <p>
                      <strong>Services:</strong> {appointment.services || "N/A"}
                    </p>
                    <p>
                      <strong>Time:</strong>{" "}
                      {formatPriorityTime(appointment.priorityTime)}
                    </p>
                    <p>
                      <strong>Slots:</strong>{" "}
                      {Math.max(0, Number(appointment.slotsRequired || 0))}
                      {isFirstJob ? " | First job" : ""}
                      {isCapacityOverride ? " | Capacity override" : ""}
                      {isWaitOverride ? " | Wait override" : ""}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
};

export default Users;
