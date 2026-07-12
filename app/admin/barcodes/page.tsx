"use client";

import { people, hardwareAssets } from "../../../lib/mockData";
import { AdminPageFrame, BarcodeTable } from "../../../components/admin/Tables";

export default function BarcodesPage() {
  return (
    <AdminPageFrame
      title="Barcode Registry"
      description="Review assigned employee, visitor, and asset identifiers, including temporary visitor IDs generated for checkpoint use."
      metric={`${people.length + hardwareAssets.length} assigned IDs`}
    >
      <BarcodeTable people={people} assets={hardwareAssets} />
    </AdminPageFrame>
  );
}
