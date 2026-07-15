"use client";

import { AdminPageFrame } from "../../../components/admin/tables/AdminPageFrame";
import { CheckpointTable } from "../../../components/admin/tables/CheckpointTable";
import { useDataState } from "../../../context/DataContext";

export default function CheckpointsPage() {
  const { checkpoints } = useDataState();
  return (
    <AdminPageFrame
      title="Checkpoint Rules"
      description="Inspect mode and zone for every controlled crossing."
      metric={`${checkpoints.length} checkpoints`}
    >
      <CheckpointTable checkpoints={checkpoints} />
    </AdminPageFrame>
  );
}
