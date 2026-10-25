// Read-only verification of the live review queue after a crawl.
import { readFile } from 'node:fs/promises';
import { firestore } from './_mail.mjs';
import { COLLECTION, PENDING, APPROVED, publishedAdvertRepeat } from './jobreview.mjs';
const db = await firestore();
if (!db) throw new Error('Queue verification requires Firebase credentials');
const site = JSON.parse(await readFile(new URL('../data/jobs.json', import.meta.url), 'utf8'));
const snapshot = await db.collection(COLLECTION).get();
const docs = snapshot.docs.map(d => d.data());
const published = [...site, ...docs.filter(d => d.status === APPROVED && d.row)
  .map(d => ({ ...d.row, ...d.edits }))];
const pending = docs.filter(d => d.status === PENDING && d.row);
const matches = pending.flatMap(d => {
  const row = { ...d.row, ...d.edits };
  const of = publishedAdvertRepeat(row, published);
  return of ? [{ rowId: d.rowId, publishedId: of.id }] : [];
});
console.log(`Queue audit: ${pending.length} pending; ${matches.length} match a published advert or Posted at link.`);
for (const match of matches) console.log(JSON.stringify(match));
if (matches.length) process.exitCode = 1;
// Opt-in recovery check for the audited October 2026 POMS false exclusions.
// A normal scheduled run must still succeed after the maintainer reviews them.
if (process.env.VERIFY_POMS_RECOVERY === 'true') {
  const huntsville = pending.find(d => d.row.adUrl === 'https://www.poms.org/sites/default/files/2026-10/9910745.pdf');
  const row = huntsville && { ...huntsville.row, ...huntsville.edits };
  if (!row || row.institution !== 'University of Alabama in Huntsville'
    || row.school !== 'College of Business' || row.unit !== 'Information Systems, Supply Chain, and Analytics'
    || JSON.stringify(row.levels) !== JSON.stringify(['Other Ranks']) || row.country !== 'United States'
    || row.reviewDate !== '2026-12-01' || row.applyByDate !== '' || !row.comments.includes('26-27-141')) {
    throw new Error('Huntsville recovery: expected corrected pending record was not found');
  }
  const uncertain = pending.find(d => d.row.source === 'poms-opportunities'
    && d.row.adUrl.includes('POM%20Job%20Board%20Assistant%20Professor%20Supply%20Chain'));
  if (!uncertain || !uncertain.dup?.length) throw new Error('Expected uncertain Texas A&M–Central Texas posting with review warnings');
  console.log('Recovery verified: Huntsville pending with correct institution, senior rank, department, country and preferred date; vacancy 26-27-141.');
  console.log('Uncertain-match policy verified: Texas A&M–Central Texas is pending with duplicate warnings, not discarded.');
  console.log('Recovered queue IDs: ' + huntsville.rowId + '; ' + uncertain.rowId);
}
