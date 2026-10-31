import assert from 'node:assert/strict';
import { retentionState, retireJobs, RETENTION_MS } from './job-retention.mjs';
import { removalSpecs, specMatches, sheetHandover, mergeRows } from './jobs-model.mjs';
import { partition } from './jobreview.mjs';
import { readFile } from 'node:fs/promises';

const now = new Date('2026-11-30T12:00:00Z');
const old = new Date(+now - RETENTION_MS).toISOString();
const recent = new Date(+now - RETENTION_MS + 1).toISOString();
const job = (status, extra = {}) => ({ status, uid: null, publishedId: 'target', updatedAt: old,
  institution: 'Private Test University', comments: 'Must be erased', email: 'test@example.invalid', ...extra });
function database(records, { race = null, failReceipt = false } = {}) {
  const data = new Map(Object.entries(records).map(([id, value]) => ['jobSubmissions/' + id, value]));
  const writes = [];
  const doc = key => ({ id: key.split('/')[1], ref: { key }, exists: data.has(key), data: () => data.get(key) });
  const db = {
    collection: name => ({ doc: id => ({ key: name + '/' + id }),
      where: (field, operator, statuses) => ({ get: async () => ({ docs: [...data.keys()]
        .filter(key => key.startsWith(name + '/') && statuses.includes(data.get(key)[field])).map(doc) }) }),
    }),
    runTransaction: async callback => {
      if (race) { race(data); race = null; }
      const staged = [];
      const result = await callback({
        get: async ref => doc(ref.key),
        set: (ref, value) => { if (failReceipt && ref.key.startsWith('jobRemovalReceipts/')) throw Error('offline'); staged.push(['set', ref.key, value]); },
        update: (ref, value) => staged.push(['set', ref.key, { ...data.get(ref.key), ...value }]),
        delete: ref => staged.push(['delete', ref.key]),
      });
      for (const [action, key, value] of staged) { if (action === 'delete') data.delete(key); else data.set(key, value); }
      writes.push(...staged);
      return result;
    },
  };
  return { db, data, writes };
}

assert.equal(retentionState(job('hidden'), now).expired, true, 'expires at exactly 30 x 24 hours');
assert.equal(retentionState(job('hidden', { updatedAt: recent }), now).expired, false, 'not one millisecond early');
for (const status of ['queued', 'published', 'sheet']) assert.equal(retentionState(job(status), now).expired, false);
assert.equal(retentionState(job('hidden', { takenDownAt: old, updatedAt: recent }), now).expired, false, 'a new takedown restarts retention');
assert.equal(retentionState(job('removed', { removedAt: now }), now).expired, true, 'bookkeeping does not restart the clock');
assert.equal(retentionState(job('hidden', { updatedAt: { toMillis: () => Date.parse(old) } }), now).expired, true);

for (const status of ['hidden', 'withdrawn', 'removed']) {
  const h = database({ target: job(status), active: job('published') });
  const counts = await retireJobs(h.db, { now });
  assert.equal(counts.deleted, 1);
  assert(!h.data.has('jobSubmissions/target'));
  assert(h.data.has('jobSubmissions/active'));
  const receipt = h.data.get('jobRemovalReceipts/target');
  assert(receipt.specs.some(s => specMatches(s, { id: 'target' })));
  for (const secret of ['Private Test University', 'Must be erased', 'test@example.invalid']) assert(!JSON.stringify(receipt).includes(secret));
  assert.deepEqual(Object.keys(receipt).sort(), ['purgedAt', 'sheetId', 'specs', 'version']);
  assert.equal((await retireJobs(h.db, { now })).deleted, 0, 'idempotent');
}
{
  const h = database({ target: job('hidden') });
  assert.equal((await retireJobs(h.db, { now, dryRun: true })).wouldDelete, 1);
  assert.equal(h.writes.length, 0, 'dry run performs zero writes');
}
{
  const h = database({ target: job('hidden') }, { race: data => data.set('jobSubmissions/target', job('queued', { updatedAt: now.toISOString() })) });
  assert.equal((await retireJobs(h.db, { now })).deleted, 0, 'concurrent restore cancels deletion');
  assert.equal(h.writes.length, 0);
}
{
  const h = database({ target: job('hidden') }, { race: data => data.set('jobSubmissions/target', job('hidden', { updatedAt: now.toISOString() })) });
  assert.equal((await retireJobs(h.db, { now })).deleted, 0, 'concurrent new takedown restarts its 30 days');
}
{
  const h = database({ target: job('hidden') }, { failReceipt: true });
  await assert.rejects(retireJobs(h.db, { now }), /offline/);
  assert(h.data.has('jobSubmissions/target'), 'receipt and deletion must commit together');
  assert.equal(h.writes.length, 0);
}
{
  const h = database({ target: job('hidden') });
  assert.equal((await retireJobs(h.db, { now, publishedRows: [{ id: 'target' }] })).deleted, 0,
    'do not delete the only handle while the posting is still served');
}
{
  const h = database({ target: job('hidden', { updatedAt: 'not-a-date' }) });
  assert.equal((await retireJobs(h.db, { now })).stamped, 1);
  assert(h.data.has('jobSubmissions/target'), 'unknown legacy age gets a full recovery window');
  assert.equal((await retireJobs(h.db, { now: new Date(+now + RETENTION_MS - 1) })).deleted, 0);
  assert.equal((await retireJobs(h.db, { now: new Date(+now + RETENTION_MS) })).deleted, 1);
}
{
  // Same-day pair: delete the sheet posting and preserve the member posting,
  // even when the member has no live document and is carried from old data.
  const sibling = { id: 'same', ref: 'MEMBER-REF', owner: 'member-owner', institution: 'Example', year: 2027, posted: '2026-10-31' };
  const target = { id: 'same-2', sourceId: 'same', institution: 'Example', year: 2027, posted: '2026-10-31' };
  const h = database({ same: job('hidden', { publishedId: target.id, sheetId: 'same', source: 'jobmarket-sheet' }) });
  h.data.set('jobReviews/same', { rowId: 'same', status: 'approved', row: { id: 'same', comments: 'Must be erased' }, edits: { institution: 'Private Test University' } });
  assert.equal((await retireJobs(h.db, { now, publishedRows: [sibling] })).deleted, 1);
  assert.deepEqual(Object.keys(h.data.get('jobReviews/same')).sort(), ['purgedAt', 'rowId', 'status']);
  const receipt = h.data.get('jobRemovalReceipts/same');
  assert(!receipt.specs.some(spec => specMatches(spec, sibling)));
  const carried = [target, sibling].filter(row => !receipt.specs.some(spec => specMatches(spec, row)));
  assert.deepEqual(carried, [sibling]);
  assert.deepEqual(mergeRows(carried, [], receipt.specs).rows, [sibling]);
  assert.equal(sheetHandover({ sheetRows: [{ id: 'same' }], pulledSheetIds: [receipt.sheetId] }).rows.length, 0,
    'source workbook cannot bring the job back');
  const gate = partition([{ id: 'same' }], [h.data.get('jobReviews/same')]);
  for (const list of ['publish', 'queue', 'refresh', 'pending', 'rejected']) assert.equal(gate[list].length, 0,
    'retired reviews disappear from every queue and cannot be reimported');
}
// This must fail with the old unscoped ID matcher, independently of served data.
const collision = removalSpecs([{ id: 'same', data: () => ({ uid: null, sheetId: 'same', publishedId: 'same-2' }) }]).specs;
assert(!collision.some(s => specMatches(s, { id: 'same', ref: 'MEMBER', owner: 'member' })));
const builder = await readFile(new URL('./build-jobs.mjs', import.meta.url), 'utf8');
assert(builder.includes("db.collection('jobRemovalReceipts').get()"), 'publisher reads suppression receipts');
assert(builder.includes('removeSpecs.push(...receipts.flatMap(r => r.specs))'), 'receipts feed real publishing removals');
assert(builder.includes('retiredSheetIds.forEach(id => claimedSheetIds.add(id))'), 'expired sheet handles cannot be recreated');
assert(builder.includes('.filter(Boolean).concat(retiredSheetIds)'), 'retired workbook rows stay suppressed');
assert(builder.includes('await retireJobs(db, { now, publishedRows: existing })'), 'scheduled builder executes retention using the previous served file');
console.log('Job retention: 30-day boundary, status gates, restore races, atomic deletion, content redaction, and no resurrection passed. Production writes: 0.');
