"use client";

import { people, hardwareAssets } from "../../../lib/mockData";
import { BarcodeTable } from "../../../components/admin/Tables";

export default function BarcodesPage() {
  return (
    <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
      <BarcodeTable people={people} assets={hardwareAssets} />
    </div>
  );
}
