import { formatPhoneNumber, getAppointmentTypeLabel } from "../../usersUtils";

function DailyPrintSheet({
  dayError,
  isDayLoading,
  printAppointments,
  selectedDateLongLabel,
}) {
  return (
    <section className="daily-print-sheet" aria-hidden="true">
      <header className="daily-print-header">
        <h1>Daily Appointments</h1>
        <p>{selectedDateLongLabel}</p>
      </header>

      {dayError ? (
        <p className="daily-print-empty">{dayError}</p>
      ) : isDayLoading ? (
        <p className="daily-print-empty">Loading appointments...</p>
      ) : printAppointments.length === 0 ? (
        <p className="daily-print-empty">No appointments scheduled for this day.</p>
      ) : (
        <table className="daily-print-table">
          <thead>
            <tr>
              <th>Appointment Type</th>
              <th>Last Name</th>
              <th>Vehicle</th>
              <th>Service / Reason</th>
              <th>Phone</th>
            </tr>
          </thead>
          <tbody>
            {printAppointments.map((appointment) => (
              <tr key={appointment.id}>
                <td>{getAppointmentTypeLabel(appointment)}</td>
                <td>{appointment.lname || "No Name"}</td>
                <td>{appointment.vehicle || "N/A"}</td>
                <td>{appointment.services || "N/A"}</td>
                <td>{formatPhoneNumber(appointment.phone)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default DailyPrintSheet;
