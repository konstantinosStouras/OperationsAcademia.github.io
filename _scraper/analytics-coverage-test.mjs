import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const A = createRequire(import.meta.url)('../assets/oa-analytics-model.js');
import { readAllDocuments, readAllReportRows, assemble } from './build-analytics.mjs';
const records = Array.from({ length: 7 }, (_, i) => ({ id: i }));
const base = { startAfter: (cursor) => query(cursor.id + 1), limit: (size) => query(0).limit(size) };
function query(offset) { return { limit: (size) => ({ get: async () => ({ docs: records.slice(offset, offset + size), size: records.slice(offset, offset + size).length }) }) }; }
assert.deepEqual(await readAllDocuments(base, 3), records);
const offsets = [];
const report = await readAllReportRows(async ({ offset, limit }) => {
  offsets.push(offset); return { rows: records.slice(offset, offset + limit), rowCount: 7 };
}, { limit: 3 });
assert.deepEqual(report.rows, records);
assert.deepEqual(offsets, [0, 3, 6]);
await assert.rejects(readAllReportRows(async ({ offset }) => {
  if (offset) throw new Error('unavailable'); return { rows: records.slice(0, 3), rowCount: 7 };
}, { limit: 3 }));
const pages = Array.from({ length: 40 }, (_, i) => ({ path: '/page-' + i, views: 1 }));
const windows = { all: { days: 0, from: '2026-10-01', to: '2026-10-08', views: 40, pages } };
const previous = assemble([{ source: 'usage', days: { '2026-10-08': [1, 40, 40] }, pages,
  pagesWindow: { from: '2026-10-01', to: '2026-10-08', views: 40 }, pagesWindows: windows }]);
assert.equal(previous.pages.length, 40);
assert.equal(previous.pagesWindows.all.pages.length, 40);
assert.deepEqual(assemble([], { carry: previous }).pagesWindows, previous.pagesWindows);
console.log('analytics coverage: pagination, complete rankings and failed-source recovery passed');

for (const domain of ['github.com', 'www.github.com', 'operations-academia.firebaseapp.com', 'firebase.google.com', 'view-awesome-table.com', 'awesome-table.com']) {
  // firebase.google.com is also Firebase infrastructure, not an external referral.
  assert.equal(A.referralAllowed(domain), false);
}
assert.equal(A.referralAllowed('en.wikipedia.org'), true);
const ref = A.breakdown('referrers', { source: 'ga4', items: [
  { name: 'github.com', value: 20 }, { name: 'view-awesome-table.com', value: 10 },
  { name: 'en.wikipedia.org', value: 5 }, { name: 'google', value: 15 },
] });
assert.equal(ref.total, 20);
assert.equal(ref.items.length, 2);
assert.deepEqual(A.referralRecord({ total: 50, items: [
  { name: 'github.com', value: 30 }, { name: 'en.wikipedia.org', value: 20 },
] }), { total: 20, items: [{ name: 'en.wikipedia.org', value: 20 }] });
