import { getAppointmentTypeLabel } from "../../usersUtils";

function DailyAppointmentSearch({
  dailySearchTerm,
  setDailySearchTerm,
  isDailySearchActive,
  dailySearchMatches,
  onSelectDailySearchResult,
}) {
  return (
    <div className="search-panel search-panel--daily">
      <input
        id="daily-appointment-search"
        type="search"
        value={dailySearchTerm}
        placeholder="Search by last name..."
        onChange={(event) => setDailySearchTerm(event.target.value)}
      />
      {isDailySearchActive ? (
        <div className="search-results">
          {dailySearchMatches.length === 0 ? (
            <p className="search-status">No matches on this day.</p>
          ) : (
            <ul className="search-hit-list">
              {dailySearchMatches.map((appointment) => (
                <li key={appointment.id}>
                  <button
                    type="button"
                    className="search-hit-button"
                    onClick={() => onSelectDailySearchResult(appointment)}
                  >
                    <span>
                      {appointment.lname || "No Name"} -{" "}
                      {getAppointmentTypeLabel(appointment)}
                    </span>
                    <span>{appointment.vehicle || "No vehicle"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default DailyAppointmentSearch;
