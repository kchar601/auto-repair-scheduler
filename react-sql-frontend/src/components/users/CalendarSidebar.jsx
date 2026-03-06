import Calendar from "react-calendar";
import GlobalAppointmentSearch from "./GlobalAppointmentSearch";
import QueuedVehiclesPanel from "./QueuedVehiclesPanel";
import {
  getAvailabilityBucket,
  normalizeDate,
  toDateKey,
} from "../../usersUtils";

function CalendarSidebar({
  selectedDate,
  setSelectedDate,
  setActiveStartDate,
  availabilityByDate,
  isWaitMode,
  setAvailabilityMode,
  error,
  isLoading,
  isPastOrSunday,
  isCalendarDisabledDay,
  globalSearchTerm,
  setGlobalSearchTerm,
  isGlobalSearchLoading,
  globalSearchError,
  globalSearchGroups,
  onSelectGlobalSearchResult,
  queuedVehicles,
  isQueuedVehiclesLoading,
  queuedVehiclesError,
  onSelectQueuedVehicle,
}) {
  return (
    <div className="sidebar">
      <GlobalAppointmentSearch
        globalSearchTerm={globalSearchTerm}
        setGlobalSearchTerm={setGlobalSearchTerm}
        isGlobalSearchLoading={isGlobalSearchLoading}
        globalSearchError={globalSearchError}
        globalSearchGroups={globalSearchGroups}
        onSelectGlobalSearchResult={onSelectGlobalSearchResult}
      />

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
        onActiveStartDateChange={({ activeStartDate: nextStartDate, view }) => {
          if (view === "month" && nextStartDate) {
            setActiveStartDate(normalizeDate(nextStartDate));
          }
        }}
        tileDisabled={({ date, view }) =>
          view === "month" && isCalendarDisabledDay(date)
        }
        tileClassName={({ date, view }) => {
          if (view !== "month") return null;
          if (isPastOrSunday(date)) return "calendar-tile calendar-tile--past";

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
            ? Math.max(
                0,
                Number(day.effectiveWaitRemaining ?? day.waitRemaining ?? 0),
              )
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

      <QueuedVehiclesPanel
        selectedDate={selectedDate}
        queuedVehicles={queuedVehicles}
        isQueuedVehiclesLoading={isQueuedVehiclesLoading}
        queuedVehiclesError={queuedVehiclesError}
        onSelectQueuedVehicle={onSelectQueuedVehicle}
      />
    </div>
  );
}

export default CalendarSidebar;
