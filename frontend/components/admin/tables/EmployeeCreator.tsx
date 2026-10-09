import { useState } from "react";
import type { CreateEmployeeInput } from "../../../../lib/types";
import { FACILITY_ZONES } from "../../../../lib/facilityZones";
import { CreationDialog } from "./CreationDialog";

const initialEmployee: CreateEmployeeInput = {
  name: "",
  barcode: "",
  allowedZones: ["public", "secure"],
};

export function EmployeeCreator({
  onCreate,
}: {
  onCreate: (input: CreateEmployeeInput) => Promise<unknown>;
}) {
  const [form, setForm] = useState(initialEmployee);
  const [error, setError] = useState("");

  function update<K extends keyof CreateEmployeeInput>(key: K, value: CreateEmployeeInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setError("");
  }

  return (
    <CreationDialog
      triggerLabel="Create"
      title="Create Employee"
      description="Add an employee identity and checkpoint access profile."
      submitLabel="Create Employee"
      cardClassName="creation-dialog-employee"
      error={error}
      onOpen={() => {
        setForm(initialEmployee);
        setError("");
      }}
      onSubmit={async () => {
        try {
          await onCreate(form);
          return true;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Unable to create the employee.");
          return false;
        }
      }}
    >
      <div className="creation-dialog-grid creation-dialog-grid-two">
        <label>
          <span>Name</span>
          <input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Employee name" required autoFocus />
        </label>
        <label>
          <span>Barcode</span>
          <input value={form.barcode} onChange={(event) => update("barcode", event.target.value)} placeholder="Employee barcode" required />
        </label>
        <label className="creation-dialog-span-two">
          <span>Allowed zones</span>
          <select value={form.allowedZones?.length === 2 ? "both" : form.allowedZones?.[0] ?? "public"} onChange={(event) => update("allowedZones", event.target.value === "both" ? ["public", "secure"] : [event.target.value])}>
            <option value="both">Both zones</option>
            {FACILITY_ZONES.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
          </select>
        </label>
      </div>
    </CreationDialog>
  );
}
