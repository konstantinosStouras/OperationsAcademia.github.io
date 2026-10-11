import assert from 'node:assert/strict';
import { aggregate } from './build-profile-analytics.mjs';
const listing = { id: 'same-id', type: 'candidate', uid: 'owner', mergedFrom: 'old-owner' };
const event = (k, extra = {}) => ({ k, c: 'job-same-id', m: 'oa-candidates', t: 10, ...extra });
const events = [event('view'), event('engagement', { d: 12 }), event('link'), event('button', { o: 1 })];
const sessions = [{ uid: 'reader', clicks: events }, { uid: 'reader', clicks: [event('view')] },
  { uid: 'owner', clicks: events }, { uid: 'old-owner', clicks: events },
  { uid: 'admin', email: 'kstouras@gmail.com', clicks: events },
  { uid: 'other', clicks: [event('view', { m: 'oa-placements' }), event('view', { m: 'oa-jobs' }), event('engagement', { d: -10 })] }];
assert.deepEqual(aggregate(sessions, listing, 0, 20), { views: 2, viewers: 1, opens: 1, clicks: 1, seconds: 12, countries: [], days: { '1970-01-01': 2 } });
assert.equal(aggregate(sessions, listing, 11, 20).views, 0);
assert.equal(aggregate(sessions, { ...listing, type: 'job' }, 0, 20).views, 1);
console.log('Profile Analytics: ownership exclusion, list attribution, repeated views, time and reporting window passed.');

import { countriesFromRows } from './build-profile-analytics.mjs';
import { createRequire } from 'node:module';
const badge = createRequire(import.meta.url)('../assets/oa-feature-badges.js');
const user = when => ({ metadata: { creationTime: when } });
assert.equal(badge.eligible(user('2026-10-01'), Date.parse('2026-11-15T23:59:59Z')), true);
assert.equal(badge.eligible(user('2026-10-18T22:59:59Z'), Date.parse('2026-10-19')), true);
assert.equal(badge.eligible(user('2026-10-18T23:00:00Z'), Date.parse('2026-10-19')), false);
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
