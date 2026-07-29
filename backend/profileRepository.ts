import { randomUUID } from "node:crypto";
import type {
  AdminProfile,
  CreateAdminAccountInput,
  ProfileSettings,
  UpdateAdminProfileInput,
} from "../services/profileService";
import { getDatabase, hashPassword, verifyPassword } from "./database";

type AdminRow = {
  id: string;
  name: string;
  nickname: string;
  email: string;
  password_hash: string;
  avatar_data_url: string;
  auto_lock: string;
  settings_json: string;
};

function toProfile(row: AdminRow): AdminProfile {
  return {
    id: row.id,
    name: row.name,
    nickname: row.nickname,
    email: row.email,
    avatarDataUrl: row.avatar_data_url,
    autoLock: row.auto_lock,
    settings: JSON.parse(row.settings_json) as ProfileSettings,
  };
}

function currentRow() {
  const database = getDatabase();
  const row = database
    .prepare(
      `SELECT id, name, nickname, email, password_hash, avatar_data_url,
              auto_lock, settings_json
       FROM admin_accounts
       WHERE is_current = 1
       LIMIT 1`
    )
    .get() as AdminRow | undefined;
  if (!row) throw new Error("No current admin profile is configured.");
  return row;
}

function validateIdentity(name: string, nickname: string, email: string) {
  if (!name.trim() || !nickname.trim() || !email.trim()) {
    throw new Error("Name, nickname, and email are required.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new Error("Enter a valid email address.");
  }
}

export function getCurrentAdminProfile() {
  return toProfile(currentRow());
}

export function updateCurrentAdminProfile(input: UpdateAdminProfileInput) {
  validateIdentity(input.name, input.nickname, input.email);
  const database = getDatabase();
  const existing = currentRow();
  if (input.newPassword) {
    if (input.newPassword.length < 8) {
      throw new Error("Your new password must contain at least 8 characters.");
    }
    if (!input.currentPassword || !verifyPassword(input.currentPassword, existing.password_hash)) {
      throw new Error("The current password is incorrect.");
    }
  }
  const duplicate = database
    .prepare(
      "SELECT id FROM admin_accounts WHERE LOWER(email) = LOWER(?) AND id <> ?"
    )
    .get(input.email.trim(), existing.id) as { id: string } | undefined;
  if (duplicate) throw new Error("An admin with this email already exists.");
  const passwordHash = input.newPassword
    ? hashPassword(input.newPassword)
    : existing.password_hash;
  database
    .prepare(
      `UPDATE admin_accounts
       SET name = ?, nickname = ?, email = ?, password_hash = ?,
           avatar_data_url = ?, auto_lock = ?, settings_json = ?
       WHERE id = ?`
    )
    .run(
      input.name.trim(),
      input.nickname.trim(),
      input.email.trim().toLowerCase(),
      passwordHash,
      input.avatarDataUrl,
      input.autoLock,
      JSON.stringify(input.settings),
      existing.id
    );
  return getCurrentAdminProfile();
}

export function createAdminAccount(input: CreateAdminAccountInput) {
  validateIdentity(input.name, input.nickname, input.email);
  if (input.password.length < 8) {
    throw new Error("Password must contain at least 8 characters.");
  }
  const database = getDatabase();
  const email = input.email.trim().toLowerCase();
  const duplicate = database
    .prepare("SELECT id FROM admin_accounts WHERE LOWER(email) = LOWER(?)")
    .get(email) as { id: string } | undefined;
  if (duplicate) throw new Error("An admin with this email already exists.");
  const id = `admin-${randomUUID()}`;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("UPDATE admin_accounts SET is_current = 0").run();
    database
      .prepare(
        `INSERT INTO admin_accounts
          (id, name, nickname, email, password_hash, avatar_data_url,
           auto_lock, settings_json, is_current, created_at)
         VALUES (?, ?, ?, ?, ?, '', '15', ?, 1, ?)`
      )
      .run(
        id,
        input.name.trim(),
        input.nickname.trim(),
        email,
        hashPassword(input.password),
        JSON.stringify({
          syncAlerts: true,
          weeklyDigest: false,
          requireReviewNote: true,
        } satisfies ProfileSettings),
        new Date().toISOString()
      );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return getCurrentAdminProfile();
}
