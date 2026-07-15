"use client";

import { AdminPageFrame } from "../../../components/admin/tables/AdminPageFrame";
import { CheckpointTable } from "../../../components/admin/tables/CheckpointTable";

export default function CheckpointsPage() {
  return (
    <AdminPageFrame
      title="Checkpoint Rules"
      description="Inspect mode and zone for every controlled crossing."
      metric={`3 checkpoints`}
    >
      <CheckpointTable />
    </AdminPageFrame>
  );
}

