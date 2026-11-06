import type { AccessPermission, Checkpoint, HardwareAsset, Person, PermissionRequest } from "../lib/types";
import { readResponse } from "./httpDataService";

export type PermissionDirectoryQuery = { limit: number; offset: number; subjectGroup?: "people" | "hardware"; search?: string; state?: string; subjectId?: string };
export type PendingPermissionQuery = { limit: number; offset: number; typeGroup?: "manual" | "other"; subjectId?: string; requestId?: string };
export type PermissionDirectoryPage = { items: AccessPermission[]; people: Person[]; hardwareAssets: HardwareAsset[]; checkpoints: Checkpoint[]; total: number; limit: number; offset: number; eventRevision?: number };
export type PendingPermissionPage = { items: PermissionRequest[]; people?: Person[]; hardwareAssets?: HardwareAsset[]; checkpoints?: Checkpoint[]; total: number; limit: number; offset: number; eventRevision?: number; summary?: { manual: number; other: number } };

async function readPage<T>(resource: string, query: object, signal?: AbortSignal): Promise<T> {
  const params = new URLSearchParams({ resource });
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  return readResponse<T>(await fetch(`/api/data?${params}`, { cache: "no-store", signal }), signal);
}

export const readPermissionDirectory = (query: PermissionDirectoryQuery, signal?: AbortSignal) => readPage<PermissionDirectoryPage>("permissionDirectory", query, signal);
export const readPendingPermissions = (query: PendingPermissionQuery, signal?: AbortSignal) => readPage<PendingPermissionPage>("pendingPermissions", query, signal);
