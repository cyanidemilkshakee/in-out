/** Application record identifiers occupy exactly one upstream path segment. */
export function recordPathSegment(value: unknown, label = "Record id"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.trim())) {
    throw new Error(`${label} must be a valid record identifier.`);
  }
  return encodeURIComponent(value.trim());
}
