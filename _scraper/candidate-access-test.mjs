import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { researchSummary } from './candidate-summary.mjs';
import { writePrivateCandidates, readPrivateCandidates } from './private-candidates.mjs';
import { CANDIDATE_PUBLIC_FIELDS } from './candidates-model.mjs';
const require = createRequire(import.meta.url);
const { createReader, FIELDS, PROFILE_COLLECTION, STATE_COLLECTION } = require('../_functions/candidate-access.js');
const Reveal = require('../assets/oa-reveal.js');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }

const row = { id: 'synthetic-1', name: 'Synthetic Candidate', year: 2027,
  researchAreas: ['Machine Learning', 'Machine Learning and Data Science', 'Deep Learning', 'Operations Research / Optimization'],
  cvUrl: 'https://example.org/cv', email: 'opted-in@example.org' };
assert.deepEqual(FIELDS, CANDIDATE_PUBLIC_FIELDS, 'server projection matches the candidate model');
assert.deepEqual(researchSummary([row]), [
  { label: 'Machine learning', count: 1 }, { label: 'Optimization', count: 1 },
], 'synonyms count each candidate only once');

// A small Firestore stand-in exercises the manifest switch and failed builds.
function database() {
  const documents = new Map();
  let failCommit = false;
  function collection(name, generation) {
    return {
      doc(id) {
        const key = name + '/' + id;
        return { key, async get() { return { exists: documents.has(key), data: () => documents.get(key) }; },
          async set(value) { documents.set(key, value); } };
      },
      where(field, op, value) { assert.equal(field, 'generation'); assert.equal(op, '=='); return collection(name, value); },
      async get() { return { docs: [...documents.entries()].filter(([key, value]) => key.startsWith(name + '/') &&
        (generation === undefined || value.generation === generation)).map(([key, value]) => ({
          id: key.slice(name.length + 1), ref: { key }, data: () => value,
        })) }; },
    };
  }
  return { documents, collection, fail() { failCommit = true; },
    batch() {
      const writes = [];
      return { set(ref, value) { writes.push(() => documents.set(ref.key, value)); },
        delete(ref) { writes.push(() => documents.delete(ref.key)); },
        async commit() { if (failCommit) { failCommit = false; throw Error('simulated-write-failure'); } writes.forEach(write => write()); } };
    },
  };
}
const db = database();
assert.equal(await readPrivateCandidates(db), null, 'first build is distinguishable from an empty cohort');
await writePrivateCandidates(db, [row], { revealAt: '2026-01-01', generated: 'first', previewTargets: { 'candidate-preview-1': row.id } });
const reader = createReader({ db: () => db, HttpsError, revealed: day => Reveal.isRevealed(day, new Date('2026-10-13')) });
let touched = false;
const lockedReader = createReader({ db: () => { touched = true; return db; }, HttpsError, revealed: () => true });
await assert.rejects(lockedReader({}), error => error.code === 'unauthenticated');
assert.equal(touched, false, 'anonymous request is refused before any private database read');
await assert.rejects(lockedReader({ auth: { uid: 'anonymous-session', token: {
  firebase: { sign_in_provider: 'anonymous' },
} } }), error => error.code === 'permission-denied');
assert.equal(touched, false, 'anonymous Firebase session is not a registered account');
await assert.rejects(lockedReader({ auth: { uid: 'pending', token: {
  firebase: { sign_in_provider: 'password' }, email_verified: false,
} } }), error => error.code === 'permission-denied');
assert.equal(touched, false, 'unverified password account cannot read private data');
const request = { auth: { uid: 'registered', token: { firebase: { sign_in_provider: 'password' }, email_verified: true } } };
assert.deepEqual((await reader(request)).rows, [row], 'registered reader gets full released profiles');
assert.deepEqual((await reader(request)).previewTargets, { 'candidate-preview-1': row.id }, 'preview targets are returned only after authentication');
db.documents.get(PROFILE_COLLECTION + '/first_' + row.id).row = { ...row, authEmail: 'private@example.org', uid: 'private-owner', note: 'private note' };
assert.deepEqual((await reader(request)).rows, [row], 'private account fields cannot pass the callable allowlist');
db.fail();
await assert.rejects(writePrivateCandidates(db, [{ ...row, id: 'replacement' }], { revealAt: '2026-01-01', generated: 'failed' }));
assert.equal(db.documents.get(STATE_COLLECTION + '/current').generated, 'first');
assert.equal((await readPrivateCandidates(db))[0].id, row.id, 'failed generation retains the last complete snapshot');
await writePrivateCandidates(db, [{ ...row, id: 'replacement' }], { revealAt: '2099-01-01', generated: 'held' });
assert.deepEqual((await reader(request)).rows, [], 'even registered users cannot read pre-reveal profiles');
assert.deepEqual(await readPrivateCandidates(db, { releasedOnly: true }), [], 'mailers and analytics respect the reveal gate');
assert.equal(db.documents.has(PROFILE_COLLECTION + '/first_' + row.id), false, 'superseded profile snapshot is removed');
assert.deepEqual(JSON.parse(await readFile(new URL('../data/candidates.json', import.meta.url), 'utf8')), [], 'public candidate URL contains no details');
const previews = JSON.parse(await readFile(new URL('../data/candidate-previews.json', import.meta.url), 'utf8'));
for (const preview of previews) assert.deepEqual(Object.keys(preview).sort(), ['affiliation', 'id', 'previewOnly', 'year']);
const rules = await readFile(new URL('../_firestore.rules', import.meta.url), 'utf8');
assert.match(rules, /match \/\{document=\*\*\} \{\s*allow read, write: if false;/, 'private snapshots stay behind the default deny rule');
assert.ok(!rules.includes('match /privateCandidate'), 'no public/private snapshot read exemption');
console.log('candidate access: anonymous and pending-account refusal, released profiles, allowlist, failed-build recovery, withdrawal and public-data checks passed');
