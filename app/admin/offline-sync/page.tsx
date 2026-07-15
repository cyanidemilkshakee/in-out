"use client";

import { AdminPageFrame } from "../../../components/admin/tables/AdminPageFrame";
import { OfflineSyncTable } from "../../../components/admin/tables/OfflineSyncTable";
import { useDataActions, useDataState } from "../../../context/DataContext";

export default function OfflineSyncPage() {
  const { movements: events } = useDataState();
  const { resolveMovementConflicts, syncMovements } = useDataActions();

  function handleResolveConflicts(eventIds: string[]) {
    void resolveMovementConflicts(eventIds);
  }

  function handleSync(eventIds?: string[]) {
    void syncMovements(eventIds);
  }

  return (
    <AdminPageFrame
      title="Offline Sync"
      description="Replay queued terminal movements, reconcile conflicts, and keep the active presence state consistent."
      metric={`${events.filter((event) => event.syncState !== "synced").length} pending`}
    >
      <OfflineSyncTable 
        events={events} 
        onResolveConflicts={handleResolveConflicts} 
        onSync={handleSync} 
      />
    </AdminPageFrame>
  );
}
