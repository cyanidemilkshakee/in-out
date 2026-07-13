"use client";

import { useEffect, useState } from "react";
import {
  Bell,
  Check,
  Clock3,
  KeyRound,
  Moon,
  Palette,
  Save,
  ShieldCheck,
  Sun,
  UserRound
} from "lucide-react";
import { AdminPageFrame } from "../../../components/admin/Tables";

type AdminTheme = "light" | "dark" | "high-contrast-dark";

const themeOptions: Array<{
  id: AdminTheme;
  label: string;
  description: string;
  icon: typeof Sun;
  swatches: string[];
}> = [
  {
    id: "light",
    label: "Light",
    description: "Bright tables and quieter contrast for long reviews.",
    icon: Sun,
    swatches: ["#f7faf9", "#0b63e5", "#16211f"]
  },
  {
    id: "dark",
    label: "Dark",
    description: "Dim surfaces for low-light checkpoint rooms.",
    icon: Moon,
    swatches: ["#111716", "#9cff6a", "#eef7f2"]
  },
  {
    id: "high-contrast-dark",
    label: "High Contrast Dark",
    description: "Black surfaces, bright text, and high-visibility signal colors.",
    icon: ShieldCheck,
    swatches: ["#000000", "#ffffff", "#ffe45c"]
  }
];

export default function ProfilePage() {
  const [theme, setTheme] = useState<AdminTheme>("light");
  const [density, setDensity] = useState("comfortable");
  const [autoLock, setAutoLock] = useState("15");
  const [saved, setSaved] = useState(false);
  const [settings, setSettings] = useState({
    incidentAlerts: true,
    syncAlerts: true,
    weeklyDigest: false,
    requireReviewNote: true,
    compactRail: false
  });

  useEffect(() => {
    const storedTheme = window.localStorage.getItem("inout-admin-theme") as AdminTheme | null;
    if (storedTheme && themeOptions.some((option) => option.id === storedTheme)) {
      setTheme(storedTheme);
    } else if (storedTheme) {
      setTheme("light");
      window.localStorage.setItem("inout-admin-theme", "light");
    }
    const storedDensity = window.localStorage.getItem("inout-admin-density");
    if (storedDensity) {
      setDensity(storedDensity);
    }
    const storedAutoLock = window.localStorage.getItem("inout-admin-autolock");
    if (storedAutoLock) {
      setAutoLock(storedAutoLock);
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.adminTheme = theme;
    window.localStorage.setItem("inout-admin-theme", theme);
  }, [theme]);

  const activeTheme = themeOptions.find((option) => option.id === theme) ?? themeOptions[0];

  function toggleSetting(key: keyof typeof settings) {
    setSettings((current) => ({ ...current, [key]: !current[key] }));
    setSaved(false);
  }

  function savePreferences() {
    window.localStorage.setItem("inout-admin-density", density);
    window.localStorage.setItem("inout-admin-autolock", autoLock);
    window.localStorage.setItem("inout-admin-settings", JSON.stringify(settings));
    setSaved(true);
  }

  return (
    <AdminPageFrame
      title="Profile & Settings"
      description="Tune your operator profile, security preferences, notifications, and admin console theme."
      metric={`${activeTheme.label} theme active`}
    >
      <section className="profile-workspace" aria-label="Profile settings">
        <header className="profile-identity-band">
          <div className="profile-avatar-large">
            <UserRound />
          </div>
          <div>
            <span>Signed in as</span>
            <h2>Ops Admin</h2>
            <p>admin@company.com / Admin role / Full operations access</p>
          </div>
          <div className="profile-session-stack">
            <span>Session</span>
            <strong>OAuth 2.0 + OIDC</strong>
            <small>Last verified 10:25 AM</small>
          </div>
        </header>

        <div className="profile-grid">
          <section className="settings-section theme-section">
            <div className="settings-section-title">
              <Palette />
              <div>
                <h2>Theme</h2>
                <p>Changes apply immediately and persist on this browser.</p>
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
                    <span className="theme-option-icon">
                      <Icon />
                    </span>
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                    <span className="theme-swatches" aria-hidden="true">
                      {option.swatches.map((color) => (
                        <i key={color} style={{ backgroundColor: color }} />
                      ))}
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
              description="Summary of movements, alerts, and scanner health."
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
              <select value={autoLock} onChange={(event) => setAutoLock(event.target.value)}>
                <option value="5">5 minutes</option>
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
                <option value="60">60 minutes</option>
              </select>
            </label>
            <SettingsToggle
              checked={settings.requireReviewNote}
              label="Require manual-review notes"
              description="Ask for an operator note before closing review cases."
              onChange={() => toggleSetting("requireReviewNote")}
            />
          </section>

          <section className="settings-section">
            <div className="settings-section-title">
              <Clock3 />
              <div>
                <h2>Console Preferences</h2>
                <p>Adjust table and navigation ergonomics.</p>
              </div>
            </div>
            <label className="profile-field">
              <span>Table density</span>
              <select value={density} onChange={(event) => setDensity(event.target.value)}>
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
                <option value="audit">Audit dense</option>
              </select>
            </label>
            <SettingsToggle
              checked={settings.compactRail}
              label="Prefer compact rail"
              description="Keep admin navigation collapsed after selection."
              onChange={() => toggleSetting("compactRail")}
            />
          </section>
        </div>

        <footer className="profile-actions">
          <span>{saved ? "Preferences saved locally." : "Unsaved profile preference changes."}</span>
          <button className="primary-button" type="button" onClick={savePreferences}>
            <Save />
            Save Preferences
          </button>
        </footer>
      </section>
    </AdminPageFrame>
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
