import { readFile } from 'node:fs/promises';
import { isMain } from './_main.mjs';
import { firestore } from './_mail.mjs';
import { readPrivateCandidates } from './private-candidates.mjs';
import { rowFromCandidateSubmission, sameCandidateKey } from './candidates-model.mjs';
import { inCurrentMarket } from './jobs-model.mjs';

// Aggregate-only output: Actions logs are public; candidate identities are not.
export function auditCandidatePublication(docs, published, hidden = {}, now = new Date()) {
  const suppressed = new Set([...(hidden.ids || []), ...(hidden.refs || [])]);
  const key = row => `${sameCandidateKey(row)}|${row.owner || ''}`;
  const keys = new Set(published.map(key));
  const report = { submissions: docs.length, statuses: {}, currentLive: 0,
    currentPublished: published.filter(r => inCurrentMarket(r, now)).length,
    represented: 0, missing: 0, invalid: 0, suppressed: 0, previousMarket: 0,
    unexpectedStatus: 0, queued: 0, pendingCv: 0, pendingResearchSummary: 0 };
  const allowed = new Set(['queued', 'published', 'withdrawn', 'hidden', 'removed']);
  for (const doc of docs) {
    const status = String(doc.status || 'missing');
    const safeStatus = allowed.has(status) ? status : 'unexpected';
    report.statuses[safeStatus] = (report.statuses[safeStatus] || 0) + 1;
    if (!allowed.has(status)) { report.unexpectedStatus++; continue; }
    if (!['queued', 'published'].includes(status)) continue;
    let row;
    try { row = rowFromCandidateSubmission(doc, { now }); } catch { /* counted below */ }
    if (!row) { report.invalid++; continue; }
    if (!inCurrentMarket(row, now)) { report.previousMarket++; continue; }
    if (suppressed.has(row.id) || suppressed.has(row.ref) || suppressed.has(doc.publishedId)) {
      report.suppressed++; continue;
    }
    report.currentLive++;
    if (status === 'queued') report.queued++;
    if (doc.cvUploadPath && !doc.cvUrl) report.pendingCv++;
    if (doc.rsUploadPath && !doc.rsUrl) report.pendingResearchSummary++;
    if (keys.has(key(row))) report.represented++;
    else report.missing++;
  }
  return report;
}

async function main() {
  const db = await firestore();
  if (!db) throw new Error('Candidate publication audit requires Firebase credentials.');
  const submissions = await db.collection('candidateSubmissions').get();
  const rows = await readPrivateCandidates(db);
  if (!rows) throw new Error('Candidate publication snapshot has not been initialized.');
  let hidden = {};
  try { hidden = JSON.parse(await readFile(new URL('../data/candidates-hidden.json', import.meta.url), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const report = auditCandidatePublication(submissions.docs.map(d => d.data()), rows, hidden);
  console.log('Candidate publication audit: ' + JSON.stringify(report));
  if (report.missing || report.invalid || report.unexpectedStatus) {
    throw new Error('Candidate publication audit found unrepresented or unreadable submissions.');
  }
}
if (isMain(import.meta.url)) main().catch(() => {
  console.error('Candidate publication audit failed; see aggregate counts above. No candidate details were logged.');
  process.exitCode = 1;
});
