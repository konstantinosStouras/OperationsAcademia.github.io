import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const A = createRequire(import.meta.url)('../assets/oa-analytics-model.js');
import { readAllDocuments, readAllReportRows, assemble, pagePeriodsFromSources, usagePeriods } from './build-analytics.mjs';
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

const usageRecords = { source: 'usage', days: { '2026-10-08': [1, 3, 3] },
  pageRecords: [{ day: '2026-10-08', pages: { '/jobs': [3, 30] } }] };
const gaRecords = { source: 'ga4', days: { '2026-10-07': [1, 5, 5], '2026-10-08': [10, 100, 100] },
  pageRecords: [{ day: '2026-10-07', pages: { '/jobs': [5, 50] } }, { day: '2026-10-08', pages: { '/jobs': [100, 1000] } }] };
const history = pagePeriodsFromSources([usageRecords, gaRecords], '2026-10-08');
assert.equal(history.all.views, 8);
assert.equal(history.all.pages[0].views, 8);
assert.equal(history.all.source, 'usage+ga4');
const mixed = assemble([usageRecords, gaRecords], { now: Date.parse('2026-10-08') });
assert.equal(mixed.pagesWindow.views, 8);
assert.deepEqual(assemble([usageRecords], { carry: mixed, now: Date.parse('2026-10-08') }).pagesWindows, mixed.pagesWindows);
const C = (await import('node:module')).createRequire(import.meta.url)('../assets/oa-candcard.js');
assert.equal(C.universityName('Operations, Haas School of Business, University of California, Berkeley'), 'University of California, Berkeley');
assert.equal(C.universityName('Operations, Kellogg School of Management, Northwestern University'), 'Northwestern University');
console.log('Historical page coverage: earlier GA4 days, overlap deduplication and failed-source retention passed');

const periods = usagePeriods([
  { day: '2026-06-01', pages: { '/jobs': [2, 20] }, hours: [2] },
  { day: '2026-10-08', pages: { '/jobs': [3, 60] }, hours: [3] },
], Date.parse('2026-10-08'));
assert.equal(periods.breakdownWindows.all.hours.total, 5);
assert.equal(periods.breakdownWindows['30'].hours.total, 3);
assert.equal(periods.engagementWindows.all.sessions, 5);
assert.equal(periods.engagementWindows['30'].sessions, 3);
const fullGa4 = { source: 'ga4', days: {}, breakdownWindows: {
  all: { hours: A.breakdown('hours', { source: 'ga4', items: [{ name: '00', value: 100 }], limit: 24 }) }
}, engagementWindows: { all: A.engagement({ source: 'ga4', sessions: 100, seconds: 500, views: 200 }) } };
const fullPeriods = assemble([{ source: 'usage', days: {}, ...periods }, fullGa4], { now: Date.parse('2026-10-08') });
assert.equal(fullPeriods.breakdownWindows.all.hours.source, 'ga4');
assert.equal(fullPeriods.breakdownWindows.all.hours.total, 100);
assert.equal(fullPeriods.engagementWindows.all.source, 'ga4');
assert.equal(fullPeriods.engagementWindows.all.sessions, 100);
console.log('Full-history GA4 hours and engagement take precedence without adding overlapping measurements');
