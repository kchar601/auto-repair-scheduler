import {
  APPOINTMENT_STATUS_STEPS,
  formatPhoneNumber,
  formatPriorityTime,
  getAppointmentStatusLabel,
  getAppointmentStatusStepIndex,
  normalizeAppointmentStatus,
} from "../../usersUtils";

function AppointmentList({
  dayError,
  isDayLoading,
  appointments,
  isDailySearchActive,
  normalizedDailySearchTerm,
  focusedAppointmentId,
  statusUpdatingAppointmentId,
  deletingAppointmentId,
  onStatusUpdate,
  onEdit,
  onDelete,
}) {
  if (dayError) {
    return <p className="day-details-status day-details-error">{dayError}</p>;
  }

  if (isDayLoading) {
    return (
      <p className="day-details-status day-details-loading">
        Loading appointments...
      </p>
    );
  }

  if (appointments.length === 0) {
    return (
      <p className="day-details-status day-details-empty">
        No appointments scheduled for this day.
      </p>
    );
  }

  return (
    <ul className="appointment-list">
      {appointments.map((appointment) => {
        const appointmentId = Number(appointment.id);
        const kind = appointment.kind || "DROPOFF";
        const isFirstJob = Number(appointment.isFirstJob) === 1;
        const isCapacityOverride = Number(appointment.isCapacityOverride) === 1;
        const isWaitOverride = Number(appointment.isWaitLimitOverride) === 1;
        const appointmentStatus = normalizeAppointmentStatus(
          appointment.status,
        );
        const isReadyForPickup = appointmentStatus === "READY_FOR_PICKUP";
        const lnameMatchesDailySearch =
          !isDailySearchActive ||
          String(appointment.lname || "")
            .trim()
            .toLowerCase()
            .includes(normalizedDailySearchTerm);
        const isDimmedByDailySearch =
          isDailySearchActive && !lnameMatchesDailySearch;
        const isAppointmentFocused = focusedAppointmentId === appointmentId;
        const statusIndex = getAppointmentStatusStepIndex(appointmentStatus);
        const statusProgressPercent =
          APPOINTMENT_STATUS_STEPS.length <= 1
            ? 0
            : (statusIndex / (APPOINTMENT_STATUS_STEPS.length - 1)) * 100;
        const isStatusUpdating = statusUpdatingAppointmentId === appointmentId;
        const isAppointmentBusy =
          isStatusUpdating || deletingAppointmentId === appointmentId;

        return (
          <li
            key={appointment.id}
            className={`appointment-item ${
              isReadyForPickup ? "appointment-item--ready" : ""
            } ${isDimmedByDailySearch ? "appointment-item--dimmed" : ""} ${
              isAppointmentFocused ? "appointment-item--focused" : ""
            }`}
            data-appointment-id={appointmentId}
          >
            <div className="appointment-header">
              <h4>{appointment.lname || "No Name"}</h4>
              {isFirstJob ? (
                <span className={"appointment-kind appointment-kind--wait"}>
                  First Job
                </span>
              ) : (
                <span
                  className={`appointment-kind appointment-kind--${String(
                    kind,
                  ).toLowerCase()}`}
                >
                  {kind}{" "}
                  {formatPriorityTime(appointment.priorityTime) === "N/A" ? (
                    ""
                  ) : (
                    <>@ {formatPriorityTime(appointment.priorityTime)}</>
                  )}
                </span>
              )}
            </div>
            <div className="appointment-status-steps">
              {APPOINTMENT_STATUS_STEPS.map((statusStep, stepIndex) => {
                const isReached = stepIndex <= statusIndex;
                const isCurrent = statusStep.value === appointmentStatus;
                return (
                  <button
                    key={statusStep.value}
                    type="button"
                    className={`appointment-status-step ${
                      isReached ? "appointment-status-step--reached" : ""
                    } ${isCurrent ? "appointment-status-step--active" : ""}`}
                    disabled={isAppointmentBusy}
                    onClick={() =>
                      onStatusUpdate(appointment, statusStep.value)
                    }
                  >
                    {statusStep.short}
                  </button>
                );
              })}
            </div>

            <p>
              <strong>Vehicle:</strong> {appointment.vehicle || "N/A"}
            </p>
            <p>
              <strong>Phone:</strong> {formatPhoneNumber(appointment.phone)}
            </p>
            <p>
              <strong>Services:</strong> {appointment.services || "N/A"}
            </p>
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
            </div>

            <div className="appointment-item-actions">
              <button
                type="button"
                className="appointment-item-action-button"
                data-type="edit"
                disabled={isAppointmentBusy}
                onClick={() => onEdit(appointment)}
              >
                ✏️
              </button>
              <button
                type="button"
                className="appointment-item-action-button"
                data-type="delete"
                disabled={isAppointmentBusy}
                onClick={() => onDelete(appointment)}
              >
                {deletingAppointmentId === appointmentId ? "Deleting..." : "🗑️"}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default AppointmentList;
