const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../assets/oa-jobedit.js'), 'utf8');
const writes = [];
let existing = null;
const db = {
  collection: () => ({ doc: id => ({ id }) }),
  runTransaction: fn => fn({
    get: async () => ({ exists: !!existing, data: () => existing }),
    set: (ref, value) => writes.push({ id: ref.id, value }),
  }),
};
const context = { window: {}, OAFB: { ready: async () => ({ firestore: () => db }) } };
context.window.OAFresh = context.OAFresh = require('../assets/oa-fresh.js');
vm.runInNewContext(source.replace('  window.OAJobEdit = {',
  '  window.testControls = { docIdFor: docIdFor, ensureHandle: ensureHandle };\n  window.OAJobEdit = {'), context);
const controls = context.window.testControls;
const permissions = context.window.OAJobEdit.__setPermissionsForTest;
const row = { id: 'orphan-job', institution: 'Example University', ref: 'OA-OLD', owner: 'original-owner' };
(async () => {
  permissions({ ready: true });
  assert.equal(controls.docIdFor(row), '', 'signed-out visitors get no editing access');
  permissions({ ready: true, uid: 'poster', byId: { owned: 'owned' } });
  assert.equal(controls.docIdFor(row), '', 'posters cannot repair other jobs');
  assert.equal(controls.docIdFor({ id: 'owned' }), 'owned');
  permissions({ ready: true, admin: true, bySheetId: { original: 'mirror-document' } });
  assert.equal(controls.docIdFor({ id: 'renamed', sourceId: 'original' }), 'mirror-document');
  assert.equal(controls.docIdFor({ id: 'original' }), 'mirror-document');
  const jobs = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/jobs.json')));
  for (const job of jobs) assert(controls.docIdFor(job), 'every served job has controls: ' + job.id);
  assert.equal(await controls.ensureHandle(row.id, row), row.id);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value.sheetId, undefined);
  assert.equal(writes[0].value.publishedId, row.id);
  assert.equal(writes[0].value.ref, row.ref);
  assert.equal(writes[0].value.owner, row.owner);
  assert.equal(writes[0].value.status, 'sheet', 'repair does not republish or withdraw');
  existing = { uid: 'concurrent-poster' };
  await assert.rejects(controls.ensureHandle(row.id, row), /identity conflict/);
  assert.equal(writes.length, 1, 'concurrent submission is never overwritten');
  existing = { uid: null, sheetId: row.id };
  assert.equal(await controls.ensureHandle(row.id, row), row.id);
  assert.equal(writes.length, 1, 'existing mirror is never overwritten');
  permissions({ ready: true });
  await assert.rejects(controls.ensureHandle(row.id, row), /unavailable/);
  console.log('Job controls: every published row manageable by maintainer; ownership and collision guards passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
