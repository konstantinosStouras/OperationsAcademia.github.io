import assert from 'node:assert/strict';
import { aggregate, listingRows } from './build-profile-analytics.mjs';
const listing = { id: 'same-id', type: 'candidate', uid: 'owner', mergedFrom: 'old-owner' };
const event = (k, extra = {}) => ({ k, c: 'job-same-id', m: 'oa-candidates', t: 10, ...extra });
const events = [event('view'), event('engagement', { d: 12 }), event('link'), event('button', { o: 1 })];
const sessions = [{ uid: 'reader', clicks: events }, { uid: 'reader', clicks: [event('view')] },
  { uid: 'owner', clicks: events }, { uid: 'old-owner', clicks: events },
  { uid: 'admin', email: 'kstouras@gmail.com', clicks: events },
  { uid: 'other', clicks: [event('view', { m: 'oa-placements' }), event('view', { m: 'oa-jobs' }), event('engagement', { d: -10 })] }];
assert.deepEqual(aggregate(sessions, listing, 0, 20), { views: 2, viewers: 1, opens: 1, clicks: 1, seconds: 12, countries: [], days: { '1970-01-01': 2 }, universities: [{ name: 'Unknown', views: 2, clicks: 1, seconds: 12, averageSeconds: 6 }], interactions: 0, parts: [] });
assert.equal(aggregate(sessions, listing, 11, 20).views, 0);
assert.equal(aggregate(sessions, { ...listing, type: 'job' }, 0, 20).views, 1);
assert.equal(aggregate([{ uid: 'reader', clicks: [event('view', { m: 'oa-past' })] }], { ...listing, type: 'job' }, 0, 20).views, 1);
assert.equal(aggregate([{ uid: 'reader', clicks: [event('view', { m: 'oa-past' })] }], listing, 0, 20).views, 0);
console.log('Profile Analytics: ownership exclusion, list attribution, repeated views, time and reporting window passed.');

import { countriesFromRows } from './build-profile-analytics.mjs';
import { createRequire } from 'node:module';
const badge = createRequire(import.meta.url)('../assets/oa-feature-badges.js');
const user = when => ({ metadata: { creationTime: when } });
assert.equal(badge.eligible(user('2026-10-01'), Date.parse('2026-11-15T23:59:59Z')), true);
assert.equal(badge.eligible(user('2026-10-18T22:59:59Z'), Date.parse('2026-10-19')), true);
assert.equal(badge.eligible(user('2026-10-18T23:00:00Z'), Date.parse('2026-10-19')), true);
assert.equal(badge.eligible(user('2026-10-01'), Date.parse('2026-11-16T00:00:00Z')), false);
assert.equal(badge.eligible(null, Date.parse('2026-10-11')), false);
const row = (url, country, date, count) => ({ dimensionValues: [url, country, date].map(value => ({ value })), metricValues: [{ value: String(count) }] });
const countries = countriesFromRows([
 row('https://www.operationsacademia.org/candidates?oa_listing=test', 'UK', '20261011', 3),
 row('https://operationsacademia.org/candidates?oa_listing=test', 'UK', '20260901', 2),
 row('https://operationsacademia.org/jobs?oa_listing=test', 'US', '20261011', 7),
 row('https://example.org/jobs?oa_listing=test', 'US', '20261011', 90)
], '2026-10-01');
assert.deepEqual(countries.get('candidate:test'), { all: [{ name: 'UK', views: 5 }], last30: [{ name: 'UK', views: 3 }] });
assert.equal(countries.get('job:test').all[0].views, 7);
console.log('Country attribution and London registration/badge expiry boundaries passed.');

const universityStats = aggregate([{ uid: 'reader', university: 'University A', clicks: events }, { uid: 'reader2', university: 'University A', clicks: [event('view'), event('engagement', { d: 24 })] }, { uid: 'reader3', university: 'University B', clicks: [event('view'), event('engagement', { d: 9 })] }], listing, 0, 20);
assert.equal(universityStats.universities[0].averageSeconds, 18);
assert.equal(universityStats.universities[0].views, 2);
assert.equal(universityStats.universities[1].averageSeconds, 9);
console.log('University totals and time weighted across visits passed.');

const detail = (p, a, n, extra = {}) => event('interaction', { p, a, s: 'visit', n, v: 2, ...extra });
const detailEvents = [detail('cv', 'link', 1), detail('cv', 'content', 2), detail('header', 'open', 3),
  detail('contact', 'link', 4), detail('arbitrary private text', 'content', 5),
  detail('cv', 'locked', 6), event('link', { p: 'cv' }), event('a', { p: 'cv' }),
  event('view'), event('engagement', { d: 15 }), event('page_engagement', { d: 50 })];
const detailSessions = [{ uid: 'reader', clicks: detailEvents },
  { uid: 'reader', clicks: [detailEvents[0]] }, // same batch event returned twice
  ...['owner', 'old-owner'].map(uid => ({ uid, clicks: detailEvents })),
  { uid: 'admin', email: 'kstouras@gmail.com', clicks: detailEvents },
  { uid: 'reader', clicks: [detail('cv', 'link', 7, { m: 'oa-jobs' }), detail('cv', 'link', 8, { t: 25 })] }];
const detailed = aggregate(detailSessions, listing, 0, 20);
assert.equal(detailed.interactions, 5);
assert.equal(detailed.seconds, 15, 'page engagement never inflates listing reading time');
assert.equal(detailed.clicks, 1, 'legacy link total stays separate from detail events');
assert.deepEqual(detailed.parts, [
  { part: 'cv', name: 'CV', clicks: 2, linkClicks: 1, views: 0, seconds: 0, averageSeconds: null },
  { part: 'contact', name: 'Contact', clicks: 1, linkClicks: 1, views: 0, seconds: 0, averageSeconds: null },
  { part: 'header', name: 'Listing header', clicks: 1, linkClicks: 0, views: 0, seconds: 0, averageSeconds: null },
  { part: 'detail', name: 'Other details', clicks: 1, linkClicks: 0, views: 0, seconds: 0, averageSeconds: null }
]);
assert.equal(aggregate(detailSessions, listing, 11, 20).interactions, 0);
assert.equal(aggregate(detailSessions, { ...listing, type: 'job' }, 0, 20).interactions, 1);
assert.equal(aggregate([...detailSessions, { uid: 'reader2', clicks: [detailEvents[0]] }], listing, 0, 20).interactions, 6, 'sequence IDs are scoped to the viewer');
assert.ok(!JSON.stringify(detailed).includes('arbitrary private text'));
console.log('Detail breakdown: no duplicate legacy clicks, owner exclusion, period/list isolation, safe labels and reading time passed.');

const privateRow = { id: 'private-row', ref: 'OA-CAND-PRIVATE' };
const privateDb = revealAt => ({ collection: () => ({
  doc: () => ({ get: async () => ({ exists: true, data: () => ({ ready: true, revealAt, generated: 'generation-1' }) }) }),
  where: (key, op, value) => {
    assert.deepEqual([key, op, value], ['generation', '==', 'generation-1']);
    return { get: async () => ({ docs: [{ data: () => ({ row: privateRow }) }] }) };
  }
}) });
assert.deepEqual(await listingRows(privateDb('2025-01-01'), 'candidate'), [privateRow]);
assert.deepEqual(await listingRows(privateDb('2099-01-01'), 'candidate'), []);
console.log('Private candidate listing mapping respects the release gate.');

const partEvent = (k, p, n, extra = {}) => event(k, { p, s: 'part-visit', n, ...extra });
const readingEvents = [partEvent('part_view', 'research_summary', 1),
  partEvent('part_engagement', 'research_summary', 2, { d: 12 }),
  partEvent('part_view', 'research_summary', 3),
  partEvent('part_engagement', 'research_summary', 4, { d: 8 }),
  partEvent('part_engagement', 'cv', 5, { d: 2 }), // view outside reporting window
  ...[-1, NaN, Infinity, 61].map((d, i) => partEvent('part_engagement', 'cv', i + 6, { d }))];
const readingSessions = [{ uid: 'reader', clicks: readingEvents },
  { uid: 'reader', clicks: readingEvents }, // retried batches cannot inflate time/views
  { uid: 'owner', clicks: readingEvents }, { uid: 'old-owner', clicks: readingEvents },
  { uid: 'admin', email: 'kstouras@gmail.com', clicks: readingEvents }];
const reading = aggregate(readingSessions, listing, 0, 20);
assert.deepEqual(reading.parts, [
  { part: 'research_summary', name: 'Research summary', clicks: 0, linkClicks: 0, views: 2, seconds: 20, averageSeconds: 10 },
  { part: 'cv', name: 'CV', clicks: 0, linkClicks: 0, views: 0, seconds: 2, averageSeconds: null }
]);
assert.equal(reading.views, 0); assert.equal(reading.seconds, 0); assert.equal(reading.interactions, 0);
assert.deepEqual(aggregate(readingSessions, listing, 11, 20).parts, []);
assert.deepEqual(aggregate(readingSessions, { ...listing, type: 'job' }, 0, 20).parts, []);
console.log('Detail time: zero-click rows, weighted averages, duplicate suppression, invalid durations, owner exclusion and reporting boundaries passed.');
