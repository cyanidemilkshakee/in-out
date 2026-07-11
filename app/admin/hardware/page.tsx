"use client";

import { useState } from "react";
import { hardwareAssets } from "../../../lib/mockData";
import { HardwareTable } from "../../../components/admin/Tables";

export default function HardwarePage() {
  const [assets, setAssets] = useState(hardwareAssets);

  function handleToggleInside(assetId: string) {
    setAssets((current) =>
      current.map((asset) =>
        asset.id === assetId ? { ...asset, inside: !asset.inside } : asset
      )
    );
  }

  return (
    <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
      <HardwareTable 
        assets={assets} 
        onToggleInside={handleToggleInside} 
      />
    </div>
  );
}
