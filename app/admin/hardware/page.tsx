"use client";

import { useState } from "react";
import { hardwareAssets } from "../../../lib/mockData";
import { AdminPageFrame, HardwareTable } from "../../../components/admin/Tables";

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
    <AdminPageFrame
      title="Hardware Custody"
      description="Track restricted exits, owner departments, and physical assets moving through monitored checkpoints."
      metric={`${assets.filter((asset) => asset.status === "restricted").length} restricted`}
    >
      <HardwareTable 
        assets={assets} 
        onToggleInside={handleToggleInside} 
      />
    </AdminPageFrame>
  );
}
