"use client";

import { useEffect, useState } from "react";
import {
  Bell,
  Check,
  KeyRound,
  Moon,
  Palette,
  Save,
  Sun,
  UserRound
} from "lucide-react";

type AdminTheme = "light" | "dark";

const themeOptions: Array<{
  id: AdminTheme;
  label: string;
  description: string;
  icon: typeof Sun;
}> = [
  {
    id: "light",
    label: "Light",
    description: "Bright tables and quieter contrast for long reviews.",
    icon: Sun
  },
  {
    id: "dark",
    label: "Dark",
    description: "Dim surfaces for low-light checkpoint rooms.",
    icon: Moon
  }
];

function readStoredTheme(): AdminTheme {
  if (typeof window === "undefined") {
    return "light";
  }

  const storedTheme = window.localStorage.getItem("inout-admin-theme");
  return storedTheme === "dark" || storedTheme === "light" ? storedTheme : "light";
}

export default function ProfilePage() {
  const [theme, setTheme] = useState<AdminTheme>(readStoredTheme);
  const [autoLock, setAutoLock] = useState("15");
  const [saved, setSaved] = useState(false);
  const [settings, setSettings] = useState({
    incidentAlerts: true,
    syncAlerts: true,
    weeklyDigest: false,
    requireReviewNote: true
  });

  useEffect(() => {
    const storedAutoLock = window.localStorage.getItem("inout-admin-autolock");
    if (storedAutoLock) setAutoLock(storedAutoLock);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.adminTheme = theme;
    window.localStorage.setItem("inout-admin-theme", theme);
  }, [theme]);

  function toggleSetting(key: keyof typeof settings) {
    setSettings((current) => ({ ...current, [key]: !current[key] }));
    setSaved(false);
  }

  function savePreferences() {
    window.localStorage.setItem("inout-admin-autolock", autoLock);
    window.localStorage.setItem("inout-admin-settings", JSON.stringify(settings));
    setSaved(true);
  }

  return (
    <main className="profile-workspace" aria-label="Profile settings">
      <header className="profile-identity-band">
        <div className="profile-avatar-large">
          <UserRound />
        </div>
        <div className="profile-identity-info">
          <span>Signed in as</span>
          <h1>Ops Admin</h1>
          <p>admin@company.com | Admin role | Full operations access</p>
        </div>
      </header>

      <div className="profile-grid">
        <section className="settings-section theme-section">
          <div className="settings-section-title">
            <Palette />
            <div>
              <h2>Theme</h2>
              <p>Changes apply immediately and persist in this browser.</p>
            </div>
          </div>
          <div className="theme-option-grid">
            {themeOptions.map((option) => {
              const Icon = option.icon;
              const active = option.id === theme;
              return (
                <button
                  key={option.id}
                  className={active ? "theme-option active" : "theme-option"}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setTheme(option.id);
                    setSaved(false);
                  }}
                >
                  <span className="theme-option-icon"><Icon /></span>
                  <span className="theme-option-body">
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                  {active ? <Check className="theme-check" /> : null}
                </button>
              );
            })}
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-title">
            <Bell />
            <div>
              <h2>Notifications</h2>
              <p>Choose what reaches this admin session.</p>
            </div>
          </div>
          <SettingsToggle
            checked={settings.incidentAlerts}
            label="Critical incident alerts"
            description="Denied access, restricted exits, and active holds."
            onChange={() => toggleSetting("incidentAlerts")}
          />
          <SettingsToggle
            checked={settings.syncAlerts}
            label="Offline sync alerts"
            description="Batch conflicts and replay failures."
            onChange={() => toggleSetting("syncAlerts")}
          />
          <SettingsToggle
            checked={settings.weeklyDigest}
            label="Weekly digest"
            description="Summary of movements and alerts."
            onChange={() => toggleSetting("weeklyDigest")}
          />
        </section>

        <section className="settings-section">
          <div className="settings-section-title">
            <KeyRound />
            <div>
              <h2>Security</h2>
              <p>Operator safeguards for admin workflows.</p>
            </div>
          </div>
          <label className="profile-field">
            <span>Auto-lock after</span>
            <select
              value={autoLock}
              onChange={(event) => {
                setAutoLock(event.target.value);
                setSaved(false);
              }}
            >
              <option value="5">5 minutes</option>
              <option value="15">15 minutes</option>
              <option value="30">30 minutes</option>
              <option value="60">60 minutes</option>
            </select>
          </label>
          <SettingsToggle
            checked={settings.requireReviewNote}
            label="Require manual-review notes"
            description="Ask for a note before closing review cases."
            onChange={() => toggleSetting("requireReviewNote")}
          />
        </section>
      </div>

      <footer className="profile-actions">
        <span className={saved ? "profile-save-status saved" : "profile-save-status"}>
          {saved ? "Preferences saved." : "Unsaved changes."}
        </span>
        <button
          className="primary-button"
          type="button"
          onClick={savePreferences}
        >
          <Save />
          Save Preferences
        </button>
      </footer>
    </main>
  );
}

function SettingsToggle({
  checked,
  label,
  description,
  onChange
}: {
  checked: boolean;
  label: string;
  description: string;
  onChange: () => void;
}) {
  return (
    <label className="settings-toggle">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input type="checkbox" checked={checked} onChange={onChange} />
    </label>
  );
}
