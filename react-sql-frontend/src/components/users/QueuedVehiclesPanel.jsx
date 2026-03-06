import { formatPriorityTime } from "../../usersUtils";

function QueuedVehiclesPanel({
  queuedVehicles,
  isQueuedVehiclesLoading,
  queuedVehiclesError,
  onSelectQueuedVehicle,
}) {
  return (
    <div className="search-panel search-panel--queued">
      <label>Queued Vehicles (Not on for today)</label>
      <div className="search-results">
        {isQueuedVehiclesLoading ? (
          <p className="search-status">Loading queued vehicles...</p>
        ) : queuedVehiclesError ? (
          <p className="search-status search-status--error">
            {queuedVehiclesError}
          </p>
        ) : queuedVehicles.length === 0 ? (
          <p className="search-status">No queued off-day vehicles.</p>
        ) : (
          <ul className="search-hit-list">
            {queuedVehicles.map((appointment) => {
              const priority = formatPriorityTime(appointment.priorityTime);
              return (
                <li key={appointment.id}>
                  <button
                    type="button"
                    className="search-hit-button"
                    onClick={() => onSelectQueuedVehicle(appointment)}
                  >
                    <span>
                      {appointment.lname || "No Name"} -{" "}
                      {appointment.vehicle || "No vehicle"}
                    </span>
                    <span>
                      {new Date(
                        `${appointment.scheduledDate}T00:00:00`,
                      ).toLocaleDateString()}
                      {priority === "N/A" ? "" : ` @ ${priority}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default QueuedVehiclesPanel;
