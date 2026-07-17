import { useState } from "react";
import type { CreateHardwareAssetInput } from "../../../services/dataService";
import { CreationDialog } from "./CreationDialog";

const initialHardware: CreateHardwareAssetInput = {
  name: "",
  barcode: "",
  owner: "",
  category: "Laptop",
  allowedZone: "Main Entrance",
  status: "active",
};

export function HardwareCreator({
  onCreate,
}: {
  onCreate: (input: CreateHardwareAssetInput) => Promise<unknown>;
}) {
  const [form, setForm] = useState(initialHardware);
  const [error, setError] = useState("");

  function update<K extends keyof CreateHardwareAssetInput>(key: K, value: CreateHardwareAssetInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setError("");
  }

  return (
    <CreationDialog
      triggerLabel="Create"
      title="Create Hardware"
      description="Register an asset, its custodian, and movement restrictions."
      submitLabel="Create Hardware"
      cardClassName="creation-dialog-hardware"
      error={error}
      onOpen={() => {
        setForm(initialHardware);
        setError("");
      }}
      onSubmit={async () => {
        try {
          await onCreate(form);
          return true;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Unable to create the hardware asset.");
          return false;
        }
      }}
    >
      <div className="creation-dialog-grid creation-dialog-grid-two">
        <label>
          <span>Asset name</span>
          <input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Hardware name" required autoFocus />
        </label>
        <label>
          <span>Barcode</span>
          <input value={form.barcode} onChange={(event) => update("barcode", event.target.value)} placeholder="Asset barcode" required />
        </label>
        <label>
          <span>Owner</span>
          <input value={form.owner} onChange={(event) => update("owner", event.target.value)} placeholder="Owner or department" required />
        </label>
        <label>
          <span>Category</span>
          <select value={form.category} onChange={(event) => update("category", event.target.value)}>
            <option>Laptop</option>
            <option>Tablet</option>
            <option>Camera</option>
            <option>Projector</option>
            <option>Network</option>
            <option>Furniture</option>
          </select>
        </label>
        <label>
          <span>Allowed zone</span>
          <select value={form.allowedZone} onChange={(event) => update("allowedZone", event.target.value)}>
            <option>Main Entrance</option>
            <option>IT Lab</option>
            <option>Server Room</option>
            <option>Warehouse</option>
            <option>Auditorium</option>
          </select>
        </label>
        <label>
          <span>Status</span>
          <select
            value={form.status}
            onChange={(event) => update("status", event.target.value as CreateHardwareAssetInput["status"])}
          >
            <option value="active">Active</option>
            <option value="restricted">Restricted</option>
            <option value="maintenance">Maintenance</option>
          </select>
        </label>
      </div>
    </CreationDialog>
  );
}
