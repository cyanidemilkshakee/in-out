"use client";

import { useState } from "react";
import { scanners } from "../../../lib/mockData";
import { ScannerTable } from "../../../components/admin/Tables";

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
    <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
      <ScannerTable 
        scannerState={scannerState} 
        onToggleScanner={handleToggleScanner} 
      />
    </div>
  );
}
