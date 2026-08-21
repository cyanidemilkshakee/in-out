import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  AdminProfile,
  CreateAdminAccountInput,
  ProfileSettings,
  UpdateAdminProfileInput,
} from "../services/profileService";
import {
  getDatabase,
  hashPassword,
  verifyPassword,
  withTransaction,
} from "./database";

type Queryable = Pick<Pool | PoolClient, "query">;

type AdminRow = {
  id: string;
  name: string;
  nickname: string;
  email: string;
  password_hash: string;
  avatar_data_url: string;
  auto_lock: string;
  settings: ProfileSettings;
};

function toProfile(row: AdminRow): AdminProfile {
  return {
    id: row.id,
    name: row.name,
    nickname: row.nickname,
    email: row.email,
    avatarDataUrl: row.avatar_data_url,
    autoLock: row.auto_lock,
    settings: row.settings,
  };
}

async function currentRow(database: Queryable) {
  const result = await database.query<AdminRow>(
    `SELECT id, name, nickname, email, password_hash, avatar_data_url,
            auto_lock, settings
     FROM admin_accounts
     WHERE is_current
     LIMIT 1`
  );
  const row = result.rows[0];
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

export async function getCurrentAdminProfile() {
  const database = await getDatabase();
  return toProfile(await currentRow(database));
}

export async function updateCurrentAdminProfile(
  input: UpdateAdminProfileInput
) {
  validateIdentity(input.name, input.nickname, input.email);
  const database = await getDatabase();
  const existing = await currentRow(database);
  if (input.newPassword) {
    if (input.newPassword.length < 8) {
      throw new Error("Your new password must contain at least 8 characters.");
    }
    if (
      !input.currentPassword ||
      !verifyPassword(input.currentPassword, existing.password_hash)
    ) {
      throw new Error("The current password is incorrect.");
    }
  }
  const email = input.email.trim().toLowerCase();
  const duplicate = await database.query<{ id: string }>(
    "SELECT id FROM admin_accounts WHERE lower(email) = lower($1) AND id <> $2",
    [email, existing.id]
  );
  if (duplicate.rows[0]) {
    throw new Error("An admin with this email already exists.");
  }
  const passwordHash = input.newPassword
    ? hashPassword(input.newPassword)
    : existing.password_hash;
  const result = await database.query<AdminRow>(
    `UPDATE admin_accounts
     SET name = $1, nickname = $2, email = $3, password_hash = $4,
         avatar_data_url = $5, auto_lock = $6, settings = $7::jsonb
     WHERE id = $8
     RETURNING id, name, nickname, email, password_hash, avatar_data_url,
               auto_lock, settings`,
    [
      input.name.trim(),
      input.nickname.trim(),
      email,
      passwordHash,
      input.avatarDataUrl,
      input.autoLock,
      JSON.stringify(input.settings),
      existing.id,
    ]
  );
  return toProfile(result.rows[0]);
}

export async function createAdminAccount(input: CreateAdminAccountInput) {
  validateIdentity(input.name, input.nickname, input.email);
  if (input.password.length < 8) {
    throw new Error("Password must contain at least 8 characters.");
  }
  const email = input.email.trim().toLowerCase();
  const id = `admin-${randomUUID()}`;
  return withTransaction(async (database) => {
    const duplicate = await database.query<{ id: string }>(
      "SELECT id FROM admin_accounts WHERE lower(email) = lower($1)",
      [email]
    );
    if (duplicate.rows[0]) {
      throw new Error("An admin with this email already exists.");
    }
    await database.query(
      "UPDATE admin_accounts SET is_current = false WHERE is_current"
    );
    const result = await database.query<AdminRow>(
      `INSERT INTO admin_accounts (
         id, name, nickname, email, password_hash, avatar_data_url,
         auto_lock, settings, is_current, created_at
       )
       VALUES ($1, $2, $3, $4, $5, '', '15', $6::jsonb, true, $7)
       RETURNING id, name, nickname, email, password_hash, avatar_data_url,
                 auto_lock, settings`,
      [
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
        new Date().toISOString(),
      ]
    );
    return toProfile(result.rows[0]);
  });
}
