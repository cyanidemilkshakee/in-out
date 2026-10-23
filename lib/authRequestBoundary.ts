export const AUTH_BODY_MAX_BYTES = 8 * 1024;
export const AUTH_BODY_TIMEOUT_MS = 5_000;

export class AuthRequestError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

const unsafeUrlCharacters = /[\\\u0000-\u001f\u007f-\u009f]/;
const unsafeFieldName = /[\u0000-\u001f\u007f-\u009f]/;

export function authRequestOrigin(requestUrl: string, configuredUrl?: string): string {
  try {
    const url = new URL(configuredUrl || requestUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.origin;
  } catch {
    throw new AuthRequestError("Authentication is not configured.", 503);
  }
}

/** A proxy's internal URL/forwarded Host must never add an allowed browser origin. */
export function isSameOriginAuthRequest(request: Request, configuredUrl?: string): boolean {
  try {
    return request.headers.get('origin') === authRequestOrigin(request.url, configuredUrl);
  } catch {
    return false;
  }
}

/** Accept only unambiguous local destinations, before Auth.js or the router parses them. */
export function safeAuthCallbackUrl(value: string, trustedOrigin: string): string {
  if (!value || value !== value.trim() || value.length > 2048 || unsafeUrlCharacters.test(value) ||
      (!value.startsWith('/') && !/^https?:\/\//i.test(value)) || value.startsWith('//')) {
    throw new AuthRequestError("The return address is invalid.", 400);
  }
  // Check encoded separators/control characters too, including a second layer
  // of percent encoding that a subsequent router or proxy could decode.
  let inspected = value;
  for (let pass = 0; pass < value.length; pass++) {
    if (unsafeUrlCharacters.test(inspected) || inspected.startsWith('//')) {
      throw new AuthRequestError("The return address is invalid.", 400);
    }
    let decoded: string;
    try { decoded = decodeURIComponent(inspected); }
    catch { throw new AuthRequestError("The return address is invalid.", 400); }
    if (decoded === inspected) break;
    inspected = decoded;
  }
  if (unsafeUrlCharacters.test(inspected) || inspected.startsWith('//')) {
    throw new AuthRequestError("The return address is invalid.", 400);
  }
  try {
    const destination = new URL(value, trustedOrigin);
    if (destination.origin !== trustedOrigin || destination.username || destination.password) throw new Error();
    return destination.href;
  } catch {
    throw new AuthRequestError("The return address is invalid.", 400);
  }
}

/** Returns an absolute same-origin URL; invalid user input uses the local fallback. */
export function safeAuthRedirect(candidate: string | undefined, baseUrl: string, fallback = '/admin'): string {
  const origin = authRequestOrigin(baseUrl);
  try { if (typeof candidate === 'string') return safeAuthCallbackUrl(candidate, origin); }
  catch { /* Untrusted return addresses use the fixed local destination. */ }
  return safeAuthCallbackUrl(fallback, origin);
}

function uniqueParameters(parameters: URLSearchParams): Map<string, string> {
  const values = new Map<string, string>();
  for (const [name, value] of parameters) {
    if (!name || unsafeFieldName.test(name) || values.has(name)) {
      throw new AuthRequestError("Authentication parameters are invalid.", 400);
    }
    values.set(name, value);
  }
  return values;
}

function validateCallback(values: Map<string, unknown>, origin: string) {
  if (!values.has('callbackUrl')) return;
  const callback = values.get('callbackUrl');
  if (typeof callback !== 'string') throw new AuthRequestError("The return address is invalid.", 400);
  safeAuthCallbackUrl(callback, origin);
}

function validateHeaders(request: Request, origin: string) {
  const suppliedOrigin = request.headers.get('origin');
  if ((request.method === 'POST' && !suppliedOrigin) || (suppliedOrigin && suppliedOrigin !== origin)) {
    throw new AuthRequestError("Request origin is not allowed.", 403);
  }
  const host = request.headers.get('host');
  if (host) {
    try {
      const parsedHost = new URL(`http://${host}`);
      if (/[\s,\\/?#@]/.test(host) || !parsedHost.hostname || parsedHost.pathname !== '/' || parsedHost.username || parsedHost.password) throw new Error();
    } catch { throw new AuthRequestError("Authentication headers are invalid.", 400); }
  }
  const redirectHeader = request.headers.get('x-auth-return-redirect');
  if (redirectHeader !== null && redirectHeader !== '1') {
    throw new AuthRequestError("Authentication headers are invalid.", 400);
  }
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && !/^\d{1,12}$/.test(contentLength)) {
    throw new AuthRequestError("Content-Length is invalid.", 400);
  }
  if (contentLength !== null && Number(contentLength) > AUTH_BODY_MAX_BYTES) {
    throw new AuthRequestError("Authentication request is too large.", 413);
  }
  const transferEncoding = request.headers.get('transfer-encoding');
  if (transferEncoding !== null && (transferEncoding.toLowerCase() !== 'chunked' || contentLength !== null)) {
    throw new AuthRequestError("Authentication headers are invalid.", 400);
  }
}

function validateAuthorizationQuery(url: URL, query: Map<string, string>) {
  // Auth.js merges query parameters into its generated OIDC authorization URL.
  // Keep client, redirect, response, scope and security parameters server-owned.
  // Match the same repeated/trailing slash forms that Auth.js accepts.
  if (url.pathname.split('/').filter(Boolean).join('/') !== 'api/auth/signin/keycloak') return;
  for (const [name, value] of query) {
    if (!((name === 'prompt' && value === 'login') || (name === 'max_age' && value === '0'))) {
      throw new AuthRequestError('Authentication parameters are invalid.', 400);
    }
  }
}

async function boundedBody(request: Request, timeoutMs: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new AuthRequestError("An authentication request body is required.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AuthRequestError("Authentication request timed out.", 408)), timeoutMs);
  });
  try {
    while (true) {
      if (performance.now() >= deadline) throw new AuthRequestError("Authentication request timed out.", 408);
      const { done, value } = await Promise.race([reader.read(), timedOut]);
      if (done) break;
      size += value.byteLength;
      if (size > AUTH_BODY_MAX_BYTES) throw new AuthRequestError("Authentication request is too large.", 413);
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof AuthRequestError) throw error;
    throw new AuthRequestError("Authentication request could not be read.", 400);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) !== size) {
    throw new AuthRequestError("Content-Length does not match the authentication request.", 400);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new AuthRequestError("Authentication request encoding is invalid.", 400); }
}

/** Validate before Auth.js reads credentials. Its own CSRF validation still runs. */
export async function prepareAuthRequest(request: Request, configuredUrl?: string, timeoutMs = AUTH_BODY_TIMEOUT_MS) {
  const origin = authRequestOrigin(request.url, configuredUrl);
  validateHeaders(request, origin);
  const url = new URL(request.url);
  if (new TextEncoder().encode(url.search).byteLength > AUTH_BODY_MAX_BYTES) {
    throw new AuthRequestError("Authentication request is too large.", 413);
  }
  const query = uniqueParameters(url.searchParams);
  validateAuthorizationQuery(url, query);
  validateCallback(query, origin);
  if (request.method !== 'POST') return { origin };
  const contentType = request.headers.get('content-type') ?? '';
  const match = /^(application\/x-www-form-urlencoded|application\/json)(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.exec(contentType);
  if (!match) throw new AuthRequestError("Authentication requests must use form or JSON data.", 415);
  const body = await boundedBody(request, timeoutMs);
  let values: Map<string, unknown>;
  if (match[1].toLowerCase() === 'application/x-www-form-urlencoded') {
    try {
      for (const component of body.split(/[&=]/)) decodeURIComponent(component.replace(/\+/g, ' '));
    } catch { throw new AuthRequestError("Authentication form data is invalid.", 400); }
    values = uniqueParameters(new URLSearchParams(body));
  } else {
    let parsed: unknown;
    try { parsed = JSON.parse(body); }
    catch { throw new AuthRequestError("Authentication JSON data is invalid.", 400); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AuthRequestError("Authentication JSON data is invalid.", 400);
    values = new Map(Object.entries(parsed));
  }
  validateCallback(values, origin);
  // Reject two different interpretations of a security-sensitive parameter.
  for (const name of ['csrfToken', 'callbackUrl', 'username', 'password', 'otp']) {
    if (query.has(name) && values.has(name)) throw new AuthRequestError("Authentication parameters are invalid.", 400);
  }
  return { origin, body };
}

/** Explicit public shape prevents provider credential objects escaping a callback. */
export function publicAuthSession(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthRequestError("Authentication response is invalid.", 502);
  const session = value as Record<string, unknown>;
  const publicSession: Record<string, unknown> = {};
  if (session.user && typeof session.user === 'object' && !Array.isArray(session.user)) {
    const user = session.user as Record<string, unknown>;
    publicSession.user = Object.fromEntries(['name', 'email', 'image']
      .filter((name) => typeof user[name] === 'string' || user[name] === null).map((name) => [name, user[name]]));
  }
  for (const field of ['subject', 'expires', 'provider']) {
    if (typeof session[field] === 'string') publicSession[field] = session[field];
  }
  if (Array.isArray(session.roles)) publicSession.roles = session.roles.filter((role) => typeof role === 'string');
  for (const field of ['authTime', 'stepUpExpiresAt', 'stepUpDurationMinutes', 'stepUpExtensionSeconds']) {
    if (typeof session[field] === 'number' && Number.isSafeInteger(session[field])) publicSession[field] = session[field];
  }
  if (session.error === 'RefreshTokenError') publicSession.error = session.error;
  return publicSession;
}

/** Only the configured provider authorization endpoint may leave the app origin. */
export function safeAuthResponseUrl(value: string, trustedOrigin: string, authorizationUrl?: string): string {
  try { return safeAuthCallbackUrl(value, trustedOrigin); }
  catch (error) {
    if (!authorizationUrl || unsafeUrlCharacters.test(value)) throw error;
    try {
      const expected = new URL(authorizationUrl);
      const destination = new URL(value);
      if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password ||
          destination.origin !== expected.origin || destination.pathname !== expected.pathname || destination.hash) throw new Error();
      return safeAuthCallbackUrl(value, expected.origin);
    } catch { throw new AuthRequestError("The return address is invalid.", 400); }
  }
}
