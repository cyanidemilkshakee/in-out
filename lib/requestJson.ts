export class RequestBodyError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export async function readJsonBody(request: Request, maxBytes = 64 * 1024, timeoutMs = 15_000): Promise<unknown> {
  const origin = request.headers.get("origin");
  const expectedOrigin = new URL(process.env.AUTH_URL || request.url).origin;
  if (origin && origin !== expectedOrigin) throw new RequestBodyError("Request origin is not allowed.", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestBodyError("Content-Type must be application/json.", 415);
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength && !/^\d+$/.test(contentLength)) throw new RequestBodyError("Content-Length is invalid.", 400);
  if (contentLength && BigInt(contentLength) > BigInt(maxBytes)) throw new RequestBodyError("Request payload is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new RequestBodyError("A JSON request body is required.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RequestBodyError("Request body timed out.", 408)), timeoutMs);
  });
  try {
    while (true) {
      if (performance.now() >= deadline) throw new RequestBodyError("Request body timed out.", 408);
      const { done, value } = await Promise.race([reader.read(), timedOut]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        throw new RequestBodyError("Request payload is too large.", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    // Cancel without awaiting a caller-controlled source's cancellation hook.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer!);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new RequestBodyError("Request body must be valid JSON.", 400); }
}
