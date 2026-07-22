"use client";

import { type ChangeEvent, useEffect, useState } from "react";
import {
  Bell,
  Camera,
  KeyRound,
  Save,
  UserCog,
  UserRound
} from "lucide-react";
import { AdminCreator, type CreateAdminInput } from "../../../components/admin/AdminCreator";



type ProfileIdentity = {
  name: string;
  nickname: string;
  email: string;
  avatarDataUrl: string;
};

type ProfileSettings = {
  syncAlerts: boolean;
  weeklyDigest: boolean;
  requireReviewNote: boolean;
};

const defaultProfile: ProfileIdentity = {
  name: "Admin",
  nickname: "ops-admin",
  email: "admin@company.com",
  avatarDataUrl: ""
};

const defaultSettings: ProfileSettings = {
  syncAlerts: true,
  weeklyDigest: false,
  requireReviewNote: true
};



export default function ProfilePage() {
  const [profile, setProfile] = useState<ProfileIdentity>(defaultProfile);
  const [autoLock, setAutoLock] = useState("15");
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState("");
  const [pictureError, setPictureError] = useState("");
  const [settings, setSettings] = useState<ProfileSettings>(defaultSettings);
  const [password, setPassword] = useState({
    current: "",
    next: "",
    confirm: ""
  });

  useEffect(() => {
    const storedAutoLock = window.localStorage.getItem("inout-admin-autolock");
    const storedProfile = window.localStorage.getItem("inout-admin-profile");
    const storedSettings = window.localStorage.getItem("inout-admin-settings");

    if (storedAutoLock) setAutoLock(storedAutoLock);

    if (storedProfile) {
      try {
        const nextProfile = { ...defaultProfile, ...JSON.parse(storedProfile) };
        setProfile({
          ...nextProfile,
          name: nextProfile.name === "Ops Admin" ? "Admin" : nextProfile.name
        });
      } catch {
        window.localStorage.removeItem("inout-admin-profile");
      }
    }

    if (storedSettings) {
      try {
        const nextSettings = JSON.parse(storedSettings) as Partial<ProfileSettings>;
        setSettings({
          syncAlerts: nextSettings.syncAlerts ?? defaultSettings.syncAlerts,
          weeklyDigest: nextSettings.weeklyDigest ?? defaultSettings.weeklyDigest,
          requireReviewNote: nextSettings.requireReviewNote ?? defaultSettings.requireReviewNote
        });
      } catch {
        window.localStorage.removeItem("inout-admin-settings");
      }
    }
  }, []);

  function markChanged() {
    setSaved(false);
    setFormError("");
  }

  function updateProfile(key: keyof ProfileIdentity, value: string) {
    setProfile((current) => ({ ...current, [key]: value }));
    markChanged();
  }

  function updatePassword(key: keyof typeof password, value: string) {
    setPassword((current) => ({ ...current, [key]: value }));
    markChanged();
  }

  function toggleSetting(key: keyof ProfileSettings) {
    setSettings((current) => ({ ...current, [key]: !current[key] }));
    markChanged();
  }

  function handlePictureChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    setPictureError("");

    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setPictureError("Choose an image file.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setPictureError("Choose an image smaller than 2 MB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        updateProfile("avatarDataUrl", reader.result);
      }
    };
    reader.onerror = () => setPictureError("The image could not be read. Try another file.");
    reader.readAsDataURL(file);
  }

  function savePreferences() {
    const cleanName = profile.name.trim();
    const cleanNickname = profile.nickname.trim();
    const cleanEmail = profile.email.trim();
    const changingPassword = Boolean(password.current || password.next || password.confirm);

    if (!cleanName || !cleanNickname || !cleanEmail) {
      setSaved(false);
      setFormError("Name, nickname, and email are required.");
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setSaved(false);
      setFormError("Enter a valid email address.");
      return;
    }

    if (changingPassword && !password.current) {
      setSaved(false);
      setFormError("Enter your current password before choosing a new one.");
      return;
    }

    if (changingPassword && password.next.length < 8) {
      setSaved(false);
      setFormError("Your new password must contain at least 8 characters.");
      return;
    }

    if (changingPassword && password.next !== password.confirm) {
      setSaved(false);
      setFormError("New password and confirmation do not match.");
      return;
    }

    const cleanProfile = {
      ...profile,
      name: cleanName,
      nickname: cleanNickname,
      email: cleanEmail
    };

    setProfile(cleanProfile);
    window.localStorage.setItem("inout-admin-profile", JSON.stringify(cleanProfile));
    window.localStorage.setItem("inout-admin-autolock", autoLock);
    window.localStorage.setItem("inout-admin-settings", JSON.stringify(settings));
    setPassword({ current: "", next: "", confirm: "" });
    setFormError("");
    setSaved(true);
  }

  function createAdmin(input: CreateAdminInput) {
    const email = input.email.trim().toLowerCase();
    const storageKey = "inout-admin-accounts";
    let accounts: Array<{ id: string; name: string; nickname: string; email: string }> = [];

    try {
      const storedAccounts = window.localStorage.getItem(storageKey);
      if (storedAccounts) accounts = JSON.parse(storedAccounts);
    } catch {
      window.localStorage.removeItem(storageKey);
    }

    if (accounts.some((account) => account.email.toLowerCase() === email)) {
      throw new Error("An admin with this email already exists.");
    }

    const account = {
      id: `admin-${Date.now()}`,
      name: input.name.trim(),
      nickname: input.nickname.trim(),
      email,
    };
    const nextProfile = { ...profile, ...account, avatarDataUrl: "" };

    window.localStorage.setItem(storageKey, JSON.stringify([account, ...accounts]));
    window.localStorage.setItem("inout-admin-profile", JSON.stringify(nextProfile));
    setProfile(nextProfile);
    setSaved(false);
    setFormError("");
  }

  return (
    <main className="profile-workspace" aria-label="Profile settings">
      <div className="profile-top-actions">
        <AdminCreator onCreate={createAdmin} />
      </div>
      <header className="profile-identity-band">
        <label className="profile-avatar-picker" aria-label="Change profile picture">
          <div className="profile-avatar-large">
            {profile.avatarDataUrl ? (
              <img src={profile.avatarDataUrl} alt={`${profile.name || "Admin"} profile`} />
            ) : (
              <UserCog aria-hidden="true" />
            )}
          </div>
          <span className="profile-avatar-edit-icon" aria-hidden="true">
            <Camera />
          </span>
          <input type="file" accept="image/*" onChange={handlePictureChange} />
        </label>
        {pictureError ? <small className="profile-picture-error" role="alert">{pictureError}</small> : null}
        <div className="profile-identity-info">
          <h1>Hello {profile.name || "Admin"}</h1>
          <div className="profile-contact-stack">
            <p className="profile-nickname">@{profile.nickname || "nickname"}</p>
            <p className="profile-email-display">{profile.email || "Email not set"}</p>
          </div>
        </div>
      </header>

      <div className="profile-grid">
        <section className="settings-section profile-details-section">
          <div className="settings-section-title">
            <UserRound aria-hidden="true" />
            <div>
              <h2>Profile details</h2>
              <p>Update how your identity appears across the admin workspace.</p>
            </div>
          </div>
          <div className="profile-form-grid profile-identity-fields">
            <label className="profile-field">
              <span>Name</span>
              <input
                type="text"
                autoComplete="name"
                value={profile.name}
                onChange={(event) => updateProfile("name", event.target.value)}
              />
            </label>
            <label className="profile-field">
              <span>Nickname</span>
              <input
                type="text"
                autoComplete="nickname"
                value={profile.nickname}
                onChange={(event) => updateProfile("nickname", event.target.value)}
              />
            </label>
          </div>
        </section>

        <section className="settings-section notification-section">
          <div className="settings-section-title">
            <Bell aria-hidden="true" />
            <div>
              <h2>Notifications</h2>
              <p>Choose what reaches this admin session.</p>
            </div>
          </div>
          <SettingsToggle
            checked={settings.syncAlerts}
            label="System health alerts"
            description="Hardware connectivity and processing failures."
            onChange={() => toggleSetting("syncAlerts")}
          />
          <SettingsToggle
            checked={settings.weeklyDigest}
            label="Weekly digest"
            description="Summary of movements and alerts."
            onChange={() => toggleSetting("weeklyDigest")}
          />
        </section>

        <section className="settings-section security-section">
          <div className="settings-section-title security-section-title">
            <KeyRound aria-hidden="true" />
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
                markChanged();
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

        <section className="settings-section password-section">
          <div className="settings-section-title">
            <KeyRound aria-hidden="true" />
            <div>
              <h2>Change password</h2>
              <p>Password values are validated here but never stored in the browser.</p>
            </div>
          </div>
          <div className="profile-form-grid profile-password-grid">
            <label className="profile-field">
              <span>Current password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={password.current}
                onChange={(event) => updatePassword("current", event.target.value)}
              />
            </label>
            <label className="profile-field">
              <span>New password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={password.next}
                onChange={(event) => updatePassword("next", event.target.value)}
              />
            </label>
            <label className="profile-field">
              <span>Confirm new password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={password.confirm}
                onChange={(event) => updatePassword("confirm", event.target.value)}
              />
            </label>
          </div>
        </section>
      </div>

      <div className="profile-save-action">
        <span className="sr-only" role="status" aria-live="polite">
          {formError || (saved ? "Your profile and preferences are saved." : "Unsaved profile changes.")}
        </span>
        <button className="primary-button" type="button" onClick={savePreferences}>
          <Save aria-hidden="true" />
          Save preferences
        </button>
      </div>
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
