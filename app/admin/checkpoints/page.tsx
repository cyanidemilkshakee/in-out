"use client";

import { useState } from "react";
import { scanners, checkpoints } from "../../../lib/mockData";
import { CheckpointTable } from "../../../components/admin/Tables";

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
    <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
      <CheckpointTable 
        scannerState={scannerState} 
        onToggleScanner={handleToggleScanner} 
      />
    </div>
  );
}
