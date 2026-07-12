"use client";

import { useState } from "react";
import { scanners } from "../../../lib/mockData";
import { AdminPageFrame, ScannerTable } from "../../../components/admin/Tables";

export default function ScannersPage() {
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
      title="Scanner Fleet"
      description="Monitor checkpoint terminal health, versions, and sync readiness before security operators start a shift."
      metric={`${scannerState.filter((scanner) => scanner.status !== "offline").length} available`}
    >
      <ScannerTable 
        scannerState={scannerState} 
        onToggleScanner={handleToggleScanner} 
      />
    </AdminPageFrame>
  );
}
