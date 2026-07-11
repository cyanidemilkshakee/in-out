"use client";

import { useState } from "react";
import { initialMovements } from "../../../lib/mockData";
import { OfflineSyncTable } from "../../../components/admin/Tables";
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
    <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
      <OfflineSyncTable 
        events={events} 
        onResolveConflicts={handleResolveConflicts} 
        onSync={handleSync} 
      />
    </div>
  );
}
