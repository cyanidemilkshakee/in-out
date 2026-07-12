"use client";

import { useState } from "react";
import { initialMovements } from "../../../lib/mockData";
import { AdminPageFrame, OfflineSyncTable } from "../../../components/admin/Tables";
import type { MovementEvent } from "../../../lib/types";

export default function OfflineSyncPage() {
  const [events, setEvents] = useState<MovementEvent[]>(initialMovements);

  function handleResolveConflicts(eventIds: string[]) {
    setEvents((current) =>
      current.map((event) =>
        eventIds.includes(event.id) ? { ...event, syncState: "synced" } : event
      )
    );
  }

  function handleSync(eventIds?: string[]) {
    if (!eventIds) {
      setEvents((current) =>
        current.map((event) =>
          event.syncState === "queued" ? { ...event, syncState: "synced" } : event
        )
      );
    } else {
      setEvents((current) =>
        current.map((event) =>
          eventIds.includes(event.id) ? { ...event, syncState: "synced" } : event
        )
      );
    }
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
