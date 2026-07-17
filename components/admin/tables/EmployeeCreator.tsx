import { useState } from "react";
import type { CreateEmployeeInput } from "../../../services/dataService";
import { CreationDialog } from "./CreationDialog";

const initialEmployee: CreateEmployeeInput = {
  name: "",
  barcode: "",
  department: "",
  accessLevel: "Employee",
  allowedZone: "All Zones",
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
          <span>Department</span>
          <input value={form.department} onChange={(event) => update("department", event.target.value)} placeholder="Department" required />
        </label>
        <label>
          <span>Access level</span>
          <select value={form.accessLevel} onChange={(event) => update("accessLevel", event.target.value)}>
            <option>Employee</option>
            <option>IT Admin</option>
            <option>Security</option>
          </select>
        </label>
        <label>
          <span>Allowed zone</span>
          <select value={form.allowedZone} onChange={(event) => update("allowedZone", event.target.value)}>
            <option>All Zones</option>
            <option>Main Entrance</option>
            <option>IT Lab</option>
            <option>Server Room</option>
            <option>Warehouse</option>
          </select>
        </label>
      </div>
    </CreationDialog>
  );
}
