"use client";

import { useState } from "react";
import { scanners } from "../../../lib/mockData";
import { AdminPageFrame, CheckpointTable } from "../../../components/admin/Tables";

export default function CheckpointsPage() {
  const [scannerState, setScannerState] = useState(scanners);

  function handleToggleScanner(scannerId: string) {
    setScannerState((current) =>
      current.map((scanner) =>
        scanner.id === scannerId
          ? { ...scanner, status: scanner.status === "online" ? "offline" : "online" }
          : scanner
      )
    );
  }

  return (
    <AdminPageFrame
      title="Checkpoint Rules"
      description="Inspect mode, zone, scanner assignment, and terminal availability for every controlled crossing."
      metric={`${scannerState.filter((scanner) => scanner.status === "online").length} online scanners`}
    >
      <CheckpointTable 
        scannerState={scannerState} 
        onToggleScanner={handleToggleScanner} 
      />
    </AdminPageFrame>
  );
}
