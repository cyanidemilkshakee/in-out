import assert from "node:assert/strict";
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
