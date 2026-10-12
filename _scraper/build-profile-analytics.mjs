import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const affiliation = createRequire(import.meta.url)('../assets/oa-affiliation.js');
import { isMain } from './_main.mjs';
import { readAllDocuments, readAllReportRows } from './build-analytics.mjs';

export function aggregate(sessions, listing, from = 0, until = Date.now()) {
  const out = { views: 0, viewers: 0, opens: 0, clicks: 0, seconds: 0, countries: [], days: {}, universities: [] };
  const viewers = new Set(), universities = new Map();
  for (const s of sessions) {
    if (!s.uid || s.uid === listing.uid || s.uid === listing.mergedFrom || s.email === 'kstouras@gmail.com') continue;
    for (const e of s.clicks || []) {
      if (!e || !Number.isFinite(e.t) || e.t < from || e.t > until || e.c !== 'job-' + listing.id) continue;
      const correct = listing.type === 'candidate' ? e.m === 'oa-candidates' : ['oa-jobs', 'oa-jobs-recent'].includes(e.m);
      if (!correct) continue;
      const name = s.university || 'Unknown';
      if (!universities.has(name)) universities.set(name, { name, views: 0, clicks: 0, seconds: 0 });
      const university = universities.get(name);
      if (e.k === 'view') university.views++;
      if (e.k === 'link') university.clicks++;
      if (e.k === 'engagement' && Number.isFinite(e.d) && e.d >= 0) university.seconds += Math.min(60, e.d);
      if (e.k === 'view') { out.views++; viewers.add(s.uid);
        const day = new Date(e.t).toISOString().slice(0, 10); out.days[day] = (out.days[day] || 0) + 1; }
      if (e.o === 1) out.opens++;
      if (e.k === 'link') out.clicks++;
      if (e.k === 'engagement' && Number.isFinite(e.d) && e.d >= 0) out.seconds += Math.min(60, e.d);
    }
  }
  out.universities = [...universities.values()].filter(u => u.views || u.clicks || u.seconds)
    .map(u => ({ ...u, seconds: Math.round(u.seconds), averageSeconds: u.views ? Math.round(u.seconds / u.views) : null }))
    .sort((a, b) => b.views - a.views || a.name.localeCompare(b.name));
  out.viewers = viewers.size; out.seconds = Math.round(out.seconds);
  return out;
}

function credentials(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return JSON.parse(Buffer.from(raw, 'base64').toString()); }
}

async function countryReports(now) {
  const credentialsValue = credentials('GA4_SERVICE_ACCOUNT');
  if (!credentialsValue) return null;
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ credentials: credentialsValue, scopes: ['https://www.googleapis.com/auth/analytics.readonly'] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${process.env.GA4_PROPERTY_ID || '384653143'}:runReport`;
  const run = async body => {
    const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Country report unavailable (${res.status}); check the GA4 reporting credential and property access.`);
    return res.json();
  };
  const from = new Date(now - 29 * 86400000).toISOString().slice(0, 10);
  const rows = await readAllReportRows(run, {
    dateRanges: [{ startDate: '2026-10-11', endDate: 'today' }],
    dimensions: [{ name: 'pageLocation' }, { name: 'country' }, { name: 'date' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'oa_listing_view', matchType: 'EXACT' } } }
  });
  return countriesFromRows(rows.rows || [], from);
}

export function countriesFromRows(rows, from) {
  const result = new Map();
  for (const row of rows) {
    let url;
    try { url = new URL(row.dimensionValues[0].value); } catch { continue; }
    if (!/^(www\.)?operationsacademia\.org$/.test(url.hostname) || !url.searchParams.has('oa_listing')) continue;
    const type = url.pathname === '/candidates' ? 'candidate' : url.pathname === '/jobs' ? 'job' : '';
    if (!type) continue;
    const id = url.searchParams.get('oa_listing'); if (!id) continue;
    const key = type + ':' + id, name = row.dimensionValues[1].value;
    const day = row.dimensionValues[2].value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    if (!result.has(key)) result.set(key, { all: new Map(), last30: new Map() });
    for (const period of day >= from ? ['all', 'last30'] : ['all']) {
      const bucket = result.get(key)[period];
      bucket.set(name, (bucket.get(name) || 0) + (Number(row.metricValues[0].value) || 0));
    }
  }
  for (const value of result.values()) for (const period of ['all', 'last30']) {
    value[period] = [...value[period]].map(([name, views]) => ({ name: name === '(not set)' ? 'Unknown' : name, views })).sort((a, b) => b.views - a.views);
  }
  return result;
}

export async function build() {
  const c = credentials('FIREBASE_SERVICE_ACCOUNT');
  if (!c) { console.log('Profile Analytics: no Firebase credential; no changes.'); return; }
  const { default: admin } = await import('firebase-admin');
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(c) });
  const db = admin.firestore(), now = Date.now();
  const sessions = (await readAllDocuments(db.collection('usageEventBatches'), 5000)).map(d => d.data());
  const names = affiliation.index(JSON.parse(await readFile(new URL('../data/university-names.json', import.meta.url), 'utf8')));
  const profiles = await readAllDocuments(db.collection('profiles'), 1000);
  const universities = new Map(profiles.map(d => [d.id, affiliation.match(d.data().affiliation || '', names)?.name || 'Unknown']));
  for (const session of sessions) session.university = universities.get(session.uid) || 'Unknown';
  const priorReports = new Map((await readAllDocuments(db.collectionGroup('analytics'), 1000)).map(d => [d.ref.path, d.data()]));
  const diagnostic = { batches: sessions.length, events: 0, viewEvents: 0, adminViewEvents: 0,
    latestEventAt: null, reports: 0, reportsWithViews: 0, countedViews: 0, priorCountedViews: 0 };
  let latestEvent = 0;
  for (const session of sessions) for (const event of session.clicks || []) {
    diagnostic.events++;
    if (event.k === 'view') {
      diagnostic.viewEvents++;
      if (session.email === 'kstouras@gmail.com') diagnostic.adminViewEvents++;
    }
    if (Number.isFinite(event.t)) latestEvent = Math.max(latestEvent, event.t);
  }
  if (latestEvent) diagnostic.latestEventAt = new Date(latestEvent).toISOString();
  let countries = null;
  try { countries = await countryReports(now); } catch (e) { console.warn(e.message); }
  for (const [type, col, file] of [['candidate', 'candidateSubmissions', 'candidates'], ['job', 'jobSubmissions', 'jobs']]) {
    const served = JSON.parse(await readFile(new URL(`../data/${file}.json`, import.meta.url), 'utf8'));
    const byRef = new Map(served.filter(r => r.ref).map(r => [r.ref, r]));
    const documents = await readAllDocuments(db.collection(col), 1000);
    for (const doc of documents) {
      const submission = doc.data(), row = byRef.get(submission.ref);
      const ref = doc.ref.collection('analytics').doc('current');
      const prior = priorReports.get(ref.path) || {};
      // Keep refreshing a withdrawn listing's rolling period using its proven mapping.
      const listingId = row?.id || (prior.sourceRef === submission.ref && prior.listingId);
      if (!listingId || !submission.uid) continue;
      const listing = { ...submission, type, id: listingId };
      const all = aggregate(sessions, listing, 0, now);
      diagnostic.reports++;
      diagnostic.countedViews += all.views;
      diagnostic.priorCountedViews += prior.all?.views || 0;
      if (all.views) diagnostic.reportsWithViews++;
      const last30 = aggregate(sessions, listing, Date.parse(new Date(now - 29 * 86400000).toISOString().slice(0, 10)), now);
      const country = countries?.get(type + ':' + listingId);
      all.countries = country?.all || (countries ? [] : prior.all?.countries || []);
      last30.countries = country?.last30 || (countries ? [] : prior.last30?.countries || []);
      const report = { all, last30, listingId, sourceRef: submission.ref, updatedAt: now, trackingSince: '2026-10-11',
        countriesReady: countries !== null || prior.countriesReady === true,
        countriesUpdatedAt: countries !== null ? now : prior.countriesUpdatedAt || null };
      if (!process.argv.includes('--dry-run')) await ref.set(report);
    }
  }
  // Dry-run diagnostics are totals only: no visitor or listing identifiers.
  if (process.argv.includes('--dry-run')) console.log('Profile Analytics diagnostic: ' + JSON.stringify(diagnostic));
  console.log('Private Profile Analytics refreshed.');
}
if (isMain(import.meta.url)) build().catch(e => { console.error(e.message); process.exitCode = 1; });
