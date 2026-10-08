import { GoogleAuth } from 'google-auth-library';
import { readAllReportRows } from './build-analytics.mjs';
const raw = process.env.GA4_SERVICE_ACCOUNT;
if (!raw) throw new Error('GA4 credential is missing.');
let credentials;
try { credentials = JSON.parse(raw); } catch { credentials = JSON.parse(Buffer.from(raw, 'base64').toString()); }
const client = await new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/analytics.readonly'] }).getClient();
const { token } = await client.getAccessToken();
const property = String(process.env.GA4_PROPERTY_ID || '').replace(/\D/g, '');
const report = await readAllReportRows(async body => {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('GA4 referral report HTTP ' + res.status);
  return res.json();
}, {
  dateRanges: [{ startDate: '89daysAgo', endDate: 'today' }],
  dimensions: [{ name: 'pageReferrer' }], metrics: [{ name: 'screenPageViews' }],
  dimensionFilter: { orGroup: { expressions: ['wikipedia.org', 'awesome-table.com', 'awesometables.com'].map(value =>
    ({ filter: { fieldName: 'pageReferrer', stringFilter: { matchType: 'CONTAINS', value } } })) } },
  limit: 1000,
});
const links = new Map();
for (const row of report.rows || []) {
  let u;
  try { u = new URL(row.dimensionValues?.[0]?.value); } catch { continue; }
  if (!/(^|\.)(wikipedia\.org|awesome-table\.com|view-awesome-table\.com|awesometables\.com)$/.test(u.hostname)) continue;
  // Only the requested source pages; strip query/fragment and any user info.
  const clean = u.origin + u.pathname;
  links.set(clean, (links.get(clean) || 0) + Number(row.metricValues?.[0]?.value || 0));
}
console.log(JSON.stringify({ period: 'last 90 days', metric: 'pageviews with this recorded referrer (not session-source visits)',
  links: [...links].map(([url, pageviews]) => ({ url, pageviews })) }));
