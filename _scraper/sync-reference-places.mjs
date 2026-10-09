/* Only institution names cross from the queues into the public directory.
   No posting, person, identifier, status, count or contact detail is exported. */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isMain } from './_main.mjs';
import { approvedRow } from './jobreview.mjs';
const require = createRequire(import.meta.url);
const S = require('../assets/oa-schools.js');
const A = require('../assets/oa-affiliation.js');

export function referencePlaces(documents, catalogue = {}) {
  const places = new Map();
  const index = A.index(catalogue);
  for (const document of documents || []) {
    let r = document.row ? approvedRow(document.row, document) : document;
    if (!r.institution && r.affiliation) {
      const match = A.match(r.affiliation, index);
      const institution = match ? match.name : A.newUniversity(r.affiliation, index);
      if (!institution) continue;
      const affiliation = S.fold(A.tidy(r.affiliation));
      const schools = (catalogue.schools || []).filter(([school, university]) =>
        S.institutionKey(university) === S.institutionKey(institution)
        && (' ' + affiliation + ' ').includes(' ' + S.fold(school) + ' '));
      r = { institution, school: schools.length === 1 ? schools[0][0] : '', unit: '' };
    }
    if (!r.institution) continue;
    const p = S.canonColumns({ institution: r.institution, school: r.school || '', unit: r.unit || '' });
    if (!p.institution) continue;
    const key = S.directoryRowKey(p.institution, p.school, p.unit);
    places.set(key, { institution: p.institution, school: p.school, department: p.unit });
  }
  return [...places.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return;
  let creds;
  try { creds = JSON.parse(raw); }
  catch { creds = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
  const project = JSON.parse(await readFile(new URL('../.firebaserc', import.meta.url))).projects.default;
  if (creds.project_id !== project) throw new Error('Reference sync: Firebase project mismatch');
  const imported = await import('firebase-admin');
  const admin = imported.default || imported;
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(creds) });
  const db = admin.firestore();
  const snapshots = await Promise.all([
    db.collection('jobReviews').where('status', 'in', ['pending', 'approved']).get(),
    db.collection('jobSubmissions').where('status', 'in', ['queued', 'published']).get(),
    db.collection('candidateSubmissions').where('status', 'in', ['queued', 'published']).get(),
  ]);
  const catalogue = JSON.parse(await readFile(new URL('../data/university-names.json', import.meta.url)));
  const places = referencePlaces(snapshots.flatMap(s => s.docs.map(d => d.data())), catalogue);
  console.log(`reference places: ${places.length} distinct institution/school/department names`);
  if (!process.argv.includes('--dry-run')) {
    await writeFile(new URL('../data/reference-places.json', import.meta.url), JSON.stringify(places, null, 1) + '\n');
  }
}
if (isMain(import.meta.url)) main().catch(err => { console.error(err.message); process.exitCode = 1; });
