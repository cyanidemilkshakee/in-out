/** Quote text and prevent spreadsheet formulas from executing in exported cells. */
export function escapeCsv(value: string): string {
  const text = /^[\s]*[=+@-]|^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${text.replaceAll('"', '""')}"`;
}
