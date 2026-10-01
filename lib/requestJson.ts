export class RequestBodyError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export async function readJsonBody(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const origin = request.headers.get("origin");
  const expectedOrigin = new URL(process.env.AUTH_URL || request.url).origin;
  if (origin && origin !== expectedOrigin) throw new RequestBodyError("Request origin is not allowed.", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestBodyError("Content-Type must be application/json.", 415);
  }
  if (Number(request.headers.get("content-length")) > maxBytes) throw new RequestBodyError("Request payload is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new RequestBodyError("A JSON request body is required.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestBodyError("Request payload is too large.", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new RequestBodyError("Request body must be valid JSON.", 400); }
}
