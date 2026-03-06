import { getAppointmentTypeLabel } from "../../usersUtils";

function GlobalAppointmentSearch({
  globalSearchTerm,
  setGlobalSearchTerm,
  isGlobalSearchLoading,
  globalSearchError,
  globalSearchGroups,
  onSelectGlobalSearchResult,
}) {
  return (
    <div className="search-panel">
      <label htmlFor="global-appointment-search">
        Search Upcoming By Last Name
      </label>
      <input
        id="global-appointment-search"
        type="search"
        value={globalSearchTerm}
        placeholder="Type last name..."
        onChange={(event) => setGlobalSearchTerm(event.target.value)}
      />
      {globalSearchTerm.trim() ? (
        <div className="search-results">
          {isGlobalSearchLoading ? (
            <p className="search-status">Searching...</p>
          ) : globalSearchError ? (
            <p className="search-status search-status--error">
              {globalSearchError}
            </p>
          ) : globalSearchGroups.length === 0 ? (
            <p className="search-status">No upcoming appointments found.</p>
          ) : (
            <ul className="search-group-list">
              {globalSearchGroups.map((group) => (
                <li key={group.lname} className="search-group-item">
                  <p className="search-group-title">{group.lname}</p>
                  <ul className="search-hit-list">
                    {group.appointments.map((appointment) => (
                      <li key={appointment.id}>
                        <button
                          type="button"
                          className="search-hit-button"
                          onClick={() =>
                            onSelectGlobalSearchResult(appointment)
                          }
                        >
                          <span>
                            {new Date(
                              `${appointment.scheduledDate}T00:00:00`,
                            ).toLocaleDateString()}{" "}
                            - {getAppointmentTypeLabel(appointment)}
                          </span>
                          <span>{appointment.vehicle || "No vehicle"}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default GlobalAppointmentSearch;
