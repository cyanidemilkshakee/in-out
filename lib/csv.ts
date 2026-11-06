/** Quote text and prevent spreadsheet formulas from executing in exported cells. */
export function escapeCsv(value: string): string {
  const text = /^[\s]*[=+@-]|^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${text.replaceAll('"', '""')}"`;
}

/** Format bounded exports in small tasks so controls and cancellation stay responsive. */
export async function formatCsvBlob<T>(headers: readonly string[], records: Iterable<T>, values: (record: T) => readonly unknown[], options: {
  signal?: AbortSignal;
  newline?: "\n" | "\r\n";
  bom?: boolean;
  maximumBytes?: number;
  yieldControl?: () => Promise<void>;
} = {}): Promise<Blob> {
  const { signal, newline = "\r\n", bom = false, maximumBytes = 16 * 1024 * 1024,
    yieldControl = () => new Promise<void>(resolve => setTimeout(resolve, 0)) } = options;
  signal?.throwIfAborted();
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let usedBytes = 0;
  let chunk = `${bom ? "\uFEFF" : ""}${headers.map(escapeCsv).join(",")}`;
  const charge = (text: string) => {
    usedBytes += encoder.encode(text).byteLength;
    if (usedBytes > maximumBytes) throw new Error("The CSV exceeds the 16 MiB export limit. Narrow the filters.");
  };
  charge(chunk);
  let rowCount = 0;
  for (const record of records) {
    signal?.throwIfAborted();
    const line = newline + values(record).map(value => escapeCsv(String(value ?? ""))).join(",");
    charge(line);
    chunk += line;
    if (++rowCount % 256 === 0) {
      parts.push(chunk);
      chunk = "";
      await yieldControl();
      signal?.throwIfAborted();
    }
  }
  if (chunk) parts.push(chunk);
  signal?.throwIfAborted();
  return new Blob(parts, { type: "text/csv;charset=utf-8" });
}
