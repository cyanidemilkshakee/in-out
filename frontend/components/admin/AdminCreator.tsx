import { useState } from "react";
import { CreationDialog } from "./tables/CreationDialog";

export type CreateAdminInput = {
  name: string;
  nickname: string;
  email: string;
};

const initialAdmin: CreateAdminInput = {
  name: "",
  nickname: "",
  email: "",
};

export function AdminCreator({
  onCreate,
}: {
  onCreate: (input: CreateAdminInput) => Promise<void> | void;
}) {
  const [form, setForm] = useState(initialAdmin);
  const [error, setError] = useState("");

  function update<K extends keyof CreateAdminInput>(key: K, value: CreateAdminInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setError("");
  }

  return (
    <CreationDialog
      triggerLabel="Create Admin"
      title="Create Admin"
      description="Create a profile for a Keycloak administrator."
      submitLabel="Create profile"
      cardClassName="creation-dialog-admin"
      error={error}
      onOpen={() => {
        setForm(initialAdmin);
        setError("");
      }}
      onSubmit={async () => {
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
      </div>
    </CreationDialog>
  );
}
