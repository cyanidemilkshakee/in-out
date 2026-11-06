import assert from "node:assert/strict";
import { formatCsvBlob } from "../lib/csv";
import { test } from "node:test";
import { ReportReadBudget } from "../lib/reportReadBudget";
import { CollectionCapacityError } from "../lib/boundedCollection";

const rows = (prefix: string, start: number, count: number) => Array.from({ length: count }, (_, index) => ({ id: prefix + (start + index) }));

test("report pages preserve every row including the final short page", async () => {
  const budget = new ReportReadBudget();
  try {
    const pages: number[] = [];
    const result = await budget.load(async page => {
      pages.push(page);
      return { items: rows("m", (page - 1) * 200, page === 1 ? 200 : 1), total: 201, pageSize: 200 };
    });
    assert.deepEqual(pages, [1, 2]);
    assert.equal(result.length, 201);
    assert.equal(result[200].id, "m200");
  } finally { budget.dispose(); }
});

test("report row allowance is shared across concurrent selected sources", async () => {
  const budget = new ReportReadBudget(3);
  try {
    await assert.rejects(Promise.all([
      budget.load(async () => ({ items: rows("m", 0, 2), total: 2 })),
      budget.load(async () => ({ items: rows("a", 0, 2), total: 2 })),
    ]), /up to 3 records/);
    let loaded = false;
    await assert.rejects(budget.load(async () => { loaded = true; return { items: [], total: 0 }; }));
    assert.equal(loaded, false);
  } finally { budget.dispose(); }
});

test("report byte allowance is shared across all selected sources", async () => {
  const budget = new ReportReadBudget(10, 90);
  try {
    await assert.rejects(Promise.all([
      budget.load(async () => ({ items: [{ id: "movement", note: "x".repeat(20) }], total: 1 })),
      budget.load(async () => ({ items: [{ id: "alert", note: "x".repeat(20) }], total: 1 })),
    ]), error => error instanceof CollectionCapacityError);
  } finally { budget.dispose(); }
});

test("an empty or changed next page cannot produce a partial report", async () => {
  for (const next of [
    { items: [], total: 201 },
    { items: [{ id: "m200" }], total: 202 },
    { items: [{ id: "m0" }], total: 201 },
  ]) {
    const budget = new ReportReadBudget();
    try {
      await assert.rejects(budget.load(async page => page === 1
        ? { items: rows("m", 0, 200), total: 201, pageSize: 200 } : next), /changed/);
    } finally { budget.dispose(); }
  }
});

test("one shared deadline stops stalled loads and prevents later requests", async () => {
  const budget = new ReportReadBudget(10, 1024, 10);
  try {
    await assert.rejects(Promise.all([
      budget.load(() => new Promise<{ items: { id: string }[]; total: number }>(() => {})),
      budget.load(() => new Promise<{ items: { id: string }[]; total: number }>(() => {})),
    ]), /timed out/);
    let loaded = false;
    await assert.rejects(budget.load(async () => { loaded = true; return { items: [], total: 0 }; }), /timed out/);
    assert.equal(loaded, false);
  } finally { budget.dispose(); }
});

test("invalid totals and page sizes fail without continuing pagination", async () => {
  for (const page of [
    { items: [], total: NaN },
    { items: [], total: -1 },
    { items: rows("m", 0, 1), total: 1, pageSize: 201 },
  ]) {
    const budget = new ReportReadBudget();
    try { await assert.rejects(budget.load(async () => page), /invalid report/); }
    finally { budget.dispose(); }
  }
});

test("chunked CSV preserves Unicode, BOM, column order, formula protection and quoted newlines", async () => {
  const records = [{ name: "Zoë🧭", note: " \t=SUM(1,2)" }, { name: 'A, "B"', note: "line\nnext" }];
  const expected = '\uFEFF"Name","Note"\r\n"Zoë🧭","\' \t=SUM(1,2)"\r\n"A, ""B""","line\nnext"';
  const bytes = new TextEncoder().encode(expected);
  const blob = await formatCsvBlob(["Name", "Note"], records, row => [row.name, row.note], { bom: true, maximumBytes: bytes.length });
  assert.equal(blob.type, "text/csv;charset=utf-8");
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  await assert.rejects(formatCsvBlob(["Name", "Note"], records, row => [row.name, row.note], { bom: true, maximumBytes: bytes.length - 1 }), /export limit/);
  assert.equal(await (await formatCsvBlob(["Value"], [null], value => [value], { newline: "\n" })).text(), '"Value"\n""');
});

test("large CSV formatting yields between bounded row batches and keeps every row", async () => {
  let formatted = 0;
  const yields: number[] = [];
  const blob = await formatCsvBlob(["id"], Array.from({ length: 513 }, (_, id) => id), id => { formatted++; return [id]; }, {
    yieldControl: async () => { yields.push(formatted); },
  });
  assert.deepEqual(yields, [256, 512]);
  assert.equal((await blob.text()).split("\r\n").length, 514);
  assert.ok((await blob.text()).endsWith('"512"'));
  let timerRan = false;
  const timer = setTimeout(() => { timerRan = true; }, 0);
  try {
    await formatCsvBlob(["id"], Array.from({ length: 257 }, (_, id) => id), id => [id]);
    assert.equal(timerRan, true);
  } finally { clearTimeout(timer); }
});

test("CSV cancellation stops row transformation and byte overflow fails before consuming the collection", async () => {
  const controller = new AbortController();
  let formatted = 0;
  await assert.rejects(formatCsvBlob(["id"], Array.from({ length: 1_000 }, (_, id) => id), id => { formatted++; return [id]; }, {
    signal: controller.signal,
    yieldControl: async () => { controller.abort(); },
  }), { name: "AbortError" });
  assert.equal(formatted, 256);
  formatted = 0;
  await assert.rejects(formatCsvBlob(["id"], [1, 2], id => { formatted++; return [id]; }, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(formatted, 0);
  await assert.rejects(formatCsvBlob(["id"], ["🧭".repeat(20), "unread"], value => { formatted++; return [value]; }, { maximumBytes: 32 }), /export limit/);
  assert.equal(formatted, 1);
});
