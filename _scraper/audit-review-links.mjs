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