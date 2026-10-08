import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { rowFromCandidateSubmission, publicCandidateRow, revealGate, collapseSameCandidate } from './candidates-model.mjs';
import { canonColumns, marketYear, ownerTag } from './jobs-model.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const preview = require('../assets/oa-candcard.js');
const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) throw new Error('Candidate audit needs the existing Firebase service account.');
let credential;
try { credential = JSON.parse(raw); } catch { credential = JSON.parse(Buffer.from(raw, 'base64').toString()); }
const { default: admin } = await import('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(credential) });
const db = admin.firestore();
const now = new Date();
const snap = await db.collection('candidateSubmissions').where('status', 'in', ['queued', 'published']).get();
const docs = snap.docs.map(d => d.data()).filter(d => Number(d.year) === marketYear(now));
const rows = [];
let invalid = 0, previewMismatch = 0, pendingCv = 0, missingCv = 0;
const stable = o => JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
for (const doc of docs) {
  const row = rowFromCandidateSubmission(doc, { now });
  if (!row) { invalid++; continue; }
  const pub = publicCandidateRow(row);
  const twin = preview.publicRowFromDoc(doc, { now, canonColumns, marketYear, ownerTag });
  if (stable(pub) !== stable(twin)) previewMismatch++;
  if (!pub.cvUrl) { if (doc.cvUploadPath) pendingCv++; else missingCv++; }
  rows.push(pub);
}
const cfg = JSON.parse(await readFile(path.join(root, 'data/candidates-reveal.json'), 'utf8'));
const held = revealGate(cfg.revealAt, now).held;
const published = JSON.parse(await readFile(path.join(root, 'data/candidates.json'), 'utf8'));
if (held && published.some(r => Number(r.year) === marketYear(now))) throw new Error('Held profiles reached the public dataset.');
console.log(JSON.stringify({ collected: docs.length, publishable: rows.length, invalid, previewMismatch,
  pendingCv, missingCv, distinctProfiles: collapseSameCandidate(rows).rows.length, held, revealAt: cfg.revealAt }));
const { chromium } = await import('playwright');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
let layoutFailures = 0, scriptFailures = 0, unsafeLinks = 0, missingDetails = 0;
const css = await Promise.all(['assets/v3.css', 'assets/oa-list.css', 'assets/oa-ui.css'].map(f => readFile(path.join(root, f), 'utf8')));
for (const width of [1440, 375]) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await context.newPage();
  // Never send candidate details or profile links outside this browser process.
  await page.route('**/*', route => route.abort());
  page.on('pageerror', () => { scriptFailures++; });
  await page.setContent('<!doctype html><html><head><base href="https://www.operationsacademia.org/"></head><body><main style="max-width:1100px;margin:auto;padding:20px"><div id="cards"></div></main></body></html>');
  for (const content of css) await page.addStyleTag({ content });
  await page.addScriptTag({ content: await readFile(path.join(root, 'assets/oa-reveal.js'), 'utf8') });
  await page.addScriptTag({ content: await readFile(path.join(root, 'assets/oa-informs.js'), 'utf8') });
  await page.addScriptTag({ content: await readFile(path.join(root, 'assets/oa-candcard.js'), 'utf8') });
  const result = await page.evaluate(rows => {
    const host = document.getElementById('cards');
    let missing = 0;
    for (const row of rows) {
      const box = document.createElement('div'); host.appendChild(box);
      const card = OACandCard.mount(box, row);
      if (!card || !card.textContent.includes(row.name) || !card.textContent.includes(row.affiliation)) missing++;
      if (row.cvUrl && !card.querySelector('a[href="' + CSS.escape(row.cvUrl) + '"]')) missing++;
    }
    return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
      unsafe: Array.from(host.querySelectorAll('a')).filter(a => !/^(https?:|mailto:)/.test(a.href)).length,
      missing };
  }, rows);
  layoutFailures += Number(result.overflow); unsafeLinks += result.unsafe; missingDetails += result.missing;
  await context.close();
}
await browser.close();
console.log(JSON.stringify({ testedWidths: [1440, 375], renderedProfiles: rows.length,
  layoutFailures, scriptFailures, unsafeLinks, missingDetails }));
if (invalid || previewMismatch || layoutFailures || scriptFailures || unsafeLinks || missingDetails) {
  throw new Error('Candidate audit failed. Only aggregate counts are logged; no profiles are published.');
}
// Source verification for the small university-network chart, counts only.
const visits = await db.collection('universityVisits').get();
let seen = 0, placed = 0, academic = 0;
const names = new Set();
visits.forEach(d => {
  const v = d.data(); seen += Number(v.seen) || 0; academic += Number(v.academic) || 0;
  for (const [name, count] of Object.entries(v.unis || {})) { names.add(name); placed += Number(count) || 0; }
});
console.log(JSON.stringify({ universityNetworkSource: { days: visits.size, seen, placed, academic, universities: names.size } }));
