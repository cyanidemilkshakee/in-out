import { useState } from "react";
import { CreationDialog } from "./tables/CreationDialog";

export type CreateAdminInput = {
  name: string;
  nickname: string;
  email: string;
  password: string;
};

const initialAdmin: CreateAdminInput = {
  name: "",
  nickname: "",
  email: "",
  password: "",
};

export function AdminCreator({
  onCreate,
}: {
  onCreate: (input: CreateAdminInput) => Promise<void> | void;
}) {
  const [form, setForm] = useState(initialAdmin);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  function update<K extends keyof CreateAdminInput>(key: K, value: CreateAdminInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setError("");
  }

  return (
    <CreationDialog
      triggerLabel="Create Admin"
      title="Create Admin"
      description="Create a new mock admin identity for this workspace."
      submitLabel="Create Admin"
      cardClassName="creation-dialog-admin"
      error={error}
      onOpen={() => {
        setForm(initialAdmin);
        setConfirmPassword("");
        setError("");
      }}
      onSubmit={async () => {
        if (form.password.length < 8) {
          setError("Password must contain at least 8 characters.");
          return false;
        }
        if (form.password !== confirmPassword) {
          setError("Password and confirmation do not match.");
          return false;
        }
        try {
          await onCreate(form);
          return true;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Unable to create the admin.");
          return false;
        }
      }}
    >
      <div className="creation-dialog-grid creation-dialog-grid-two">
        <label>
          <span>Name</span>
          <input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Admin name" required autoFocus />
        </label>
        <label>
          <span>Nickname</span>
          <input value={form.nickname} onChange={(event) => update("nickname", event.target.value)} placeholder="Nickname" required />
        </label>
        <label className="creation-dialog-span-two">
          <span>Email</span>
          <input type="email" value={form.email} onChange={(event) => update("email", event.target.value)} placeholder="admin@company.com" required />
        </label>
        <label>
          <span>Password</span>
          <input type="password" value={form.password} onChange={(event) => update("password", event.target.value)} placeholder="Minimum 8 characters" required />
        </label>
        <label>
          <span>Confirm password</span>
          <input type="password" value={confirmPassword} onChange={(event) => { setConfirmPassword(event.target.value); setError(""); }} placeholder="Repeat password" required />
        </label>
      </div>
    </CreationDialog>
  );
}
