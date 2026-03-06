function DaySummaryCard({
  selectedDayData,
  selectedDateLongLabel,
  isMechanicsModalOpen,
  closeMechanicsModal,
  openMechanicsModal,
  handlePrintDailyAppointments,
  canCreateForSelectedDate,
  isEditingAppointment,
  isCreateFormOpen,
  closeAppointmentForm,
  openNewAppointmentForm,
  createSuccess,
  selectedRemaining,
  selectedUsed,
  selectedCapacity,
  selectedWaitUsed,
  selectedWaitLimit,
  selectedWaitRemaining,
}) {
  if (!selectedDayData) return null;

  return (
    <div className="selected-day-summary">
      <div className="selected-day-summary-header">
        <h2>{selectedDateLongLabel}</h2>
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
          <button
            type="button"
            className="summary-action-button summary-action-button--print"
            onClick={handlePrintDailyAppointments}
          >
            Print day
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
        <p className="create-status create-status-success">{createSuccess}</p>
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
        <p>
          {Number(selectedDayData?.draftLockCount || 0)} temporary hold(s)
          active
        </p>
      ) : null}
    </div>
  );
}

export default DaySummaryCard;
