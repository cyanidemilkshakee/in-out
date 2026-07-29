export type ProfileSettings = {
  syncAlerts: boolean;
  weeklyDigest: boolean;
  requireReviewNote: boolean;
};

export type AdminProfile = {
  id: string;
  name: string;
  nickname: string;
  email: string;
  avatarDataUrl: string;
  autoLock: string;
  settings: ProfileSettings;
};

export type UpdateAdminProfileInput = {
  name: string;
  nickname: string;
  email: string;
  avatarDataUrl: string;
  autoLock: string;
  settings: ProfileSettings;
  currentPassword?: string;
  newPassword?: string;
};

export type CreateAdminAccountInput = {
  name: string;
  nickname: string;
  email: string;
  password: string;
};

async function readResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | { data?: T; error?: string }
    | null;
  if (!response.ok) {
    throw new Error(body?.error ?? "Profile request failed.");
  }
  if (!body || !("data" in body)) {
    throw new Error("Profile backend returned an invalid response.");
  }
  return body.data as T;
}

export async function getAdminProfile() {
  return readResponse<AdminProfile>(
    await fetch("/api/profile", { cache: "no-store" })
  );
}

export async function updateAdminProfile(input: UpdateAdminProfileInput) {
  return readResponse<AdminProfile>(
    await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

export async function createAdminAccount(input: CreateAdminAccountInput) {
  return readResponse<AdminProfile>(
    await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}
