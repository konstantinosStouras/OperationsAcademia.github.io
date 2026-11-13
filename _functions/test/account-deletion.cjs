'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const A = require('../account-access');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
function fixture() {
  const records = new Map(), calls = [];
  const ref = path => ({ path, get: async () => snap(path) });
  const snap = path => ({ exists: records.has(path), data: () => records.get(path) });
  const db = {
    collection: name => ({ doc: id => ref(name + '/' + id) }),
    getAll: async (...refs) => refs.map(r => snap(r.path)),
    runTransaction: async fn => {
      const writes = [];
      await fn({ get: async r => snap(r.path), set: (r, data) => writes.push([r.path, data]) });
      for (const [path, data] of writes) records.set(path, data);
    }
  };
  const user = { uid: 'target', email: 'b.ot+one@gmail.com', providerData: [{ providerId: 'oidc.orcid', uid: 'orcid-id' }] };
  const auth = {
    getUser: async uid => { if (uid !== user.uid) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' }); return user; },
    updateUser: async (uid, patch) => { assert(records.has('accountBlocks/' + uid)); calls.push(['disable', patch.disabled]); },
    revokeRefreshTokens: async uid => calls.push(['revoke', uid])
  };
  const deps = { db, auth, HttpsError };
  const request = { auth: { uid: 'admin', token: { email: 'kstouras@gmail.com', email_verified: true } }, data: { uid: 'target', email: 'victim@example.test' } };
  return { records, calls, user, deps, request };
}
test('only the verified maintainer can delete; missing UID and maintainer deletion fail', async () => {
  for (const auth of [null, { uid: 'other', token: { email: 'other@example.test', email_verified: true } }, { uid: 'admin', token: { email: 'kstouras@gmail.com', email_verified: false } }]) {
    const f = fixture(); await assert.rejects(A.createAdminDelete(f.deps)({ ...f.request, auth })); assert.equal(f.records.size, 0);
  }
  const f = fixture();
  await assert.rejects(A.queueDeletion(f.deps, 'bad/path'));
  await assert.rejects(A.queueDeletion(f.deps, 'missing'));
  f.user.email = 'kstouras@gmail.com';
  await assert.rejects(A.createAdminDelete(f.deps)(f.request)); assert.equal(f.records.size, 0);
});
test('atomic block, disable and revocation; ignores supplied email; retries are idempotent', async () => {
  const f = fixture(), run = A.createAdminDelete(f.deps);
  await run(f.request);
  assert.deepEqual(f.calls, [['disable', true], ['revoke', 'target']]);
  assert(f.records.has('blockedIdentities/' + A.emailKey('bot@gmail.com')));
  assert(!f.records.has('blockedIdentities/' + A.emailKey(f.request.data.email)));
  const before = f.records.get('accountDeletions/target').askedAt;
  await run(f.request);
  assert.equal(f.records.get('accountDeletions/target').askedAt, before);
  await assert.rejects(A.assertActive(f.deps.db, 'target', HttpsError), { code: 'permission-denied' });
  await assert.rejects(A.checkIdentity(f.deps.db, { uid: 'new', email: 'b.o.t+retry@googlemail.com' }, HttpsError));
  await assert.rejects(A.checkIdentity(f.deps.db, { uid: 'new', providerData: f.user.providerData }, HttpsError));
  await A.checkIdentity(f.deps.db, { uid: 'new', email: 'real@example.test' }, HttpsError);
});
test('Auth failure leaves durable block and queue; self-deletion does not ban a mailbox', async () => {
  const f = fixture(); f.deps.auth.revokeRefreshTokens = async () => { throw new Error('outage'); };
  await assert.rejects(A.createAdminDelete(f.deps)(f.request), /outage/);
  assert(f.records.has('accountBlocks/target')); assert(f.records.has('accountDeletions/target'));
  const self = fixture(); await A.queueDeletion(self.deps, 'target', 'self');
  assert(![...self.records.keys()].some(k => k.startsWith('blockedIdentities/')));
});
test('cleanup errors propagate; nested deletion and storage generations are requested', async () => {
  const { eraseTree, eraseUploads } = await import('../../_scraper/account-erasure.mjs');
  let erased;
  await eraseTree({ recursiveDelete: async r => { erased = r; } }, 'parent'); assert.equal(erased, 'parent');
  await assert.rejects(eraseTree({ recursiveDelete: async () => { throw Error('nested failure'); } }, 'parent'));
  await assert.rejects(eraseUploads(null, 'target'));
  await assert.rejects(eraseUploads({ getFiles: async options => {
    assert.deepEqual(options, { prefix: 'uploads/target/', versions: true });
    return [[{ delete: async () => { throw Error('upload failure'); } }]];
  } }, 'target'), /upload failure/);
});

test('browser Delete uses the callable and never reports blocked cleanup as complete', async () => {
  const vm = require('node:vm'), fs = require('node:fs');
  let sent;
  const window = { OAFB: { readyFunctions: async () => ({ functions: () => ({ httpsCallable: name => async data => { sent = { name, data }; return { data: { accessBlocked: true } }; } }) }) } };
  const context = { window, self: window, document: { readyState: 'complete', getElementById: () => null } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../assets/oa-account-delete.js'), 'utf8'), context);
  const D = window.OAAccountDelete;
  const order = await D.requestFor({ uid: 'target', email: 'ignored@example.test' });
  assert.equal(sent.name, 'adminDeleteAccount'); assert.deepEqual(Object.keys(sent.data), ['uid']);
  assert.equal(D.stateOf(order).cancellable, false); assert.equal(D.stateOf(order).queued, true);
  assert.equal(D.stateOf({ status: 'done' }).label, 'Deleted');
  assert.match(D.stateOf({ cleanupError: true, status: 'clearing' }).label, /retry/);
});

test('forum erasure removes authored content, copied quotes and votes while preserving other replies', async () => {
  const { createHmac } = require('node:crypto');
  const { eraseForum } = await import('../../_scraper/account-erasure.mjs');
  const H = createHmac('sha256', 'secret').update('2026:target').digest('hex');
  const prefix = 'forumSeasons/2026/rooms/open/threads/t';
  const records = new Map([
    ['forumSeasons/2026', { secretVersion: '1' }], ['forumHandles/' + H, { handle: 'Old Handle' }],
    ['forumNames/old-handle', { key: H }],
    [prefix, { by: 'Old Handle', lastBy: 'Other Handle', title: 'private title', excerpt: 'private excerpt', score: 1, accepted: 'p1' }],
    [prefix + '/posts/p1', { n: 1, by: 'Old Handle', body: 'private words', up: 1, down: 0 }],
    [prefix + '/posts/p2', { n: 2, by: 'Other Handle', body: 'keep this reply', up: 1, down: 0, quote: { by: 'Old Handle', text: 'private words' } }],
    [prefix + '/posts/p2/votes/' + H, { v: 1 }]
  ]);
  const ref = path => ({ path, id: path.split('/').pop(), get: async () => snap(path), collection: name => collection(path + '/' + name), update: async patch => records.set(path, { ...records.get(path), ...patch }) });
  const snap = path => ({ id: path.split('/').pop(), ref: ref(path), exists: records.has(path), data: () => records.get(path) });
  const collection = (path, filter = () => true) => ({ doc: id => ref(path + '/' + id),
    where: (field, op, value) => collection(path, data => data[field] === value),
    get: async () => ({ docs: [...records.keys()].filter(k => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/') && filter(records.get(k))).map(snap) }) });
  const db = { collection, recursiveDelete: async r => { for (const k of records.keys()) if (k === r.path || k.startsWith(r.path + '/')) records.delete(k); },
    runTransaction: async fn => fn({ get: r => r.get(), update: (r, patch) => r.update(patch), delete: r => records.delete(r.path) }) };
  await eraseForum({ db }, 'target', async () => 'secret');
  assert.equal(records.get(prefix + '/posts/p1').body, '');
  assert.equal(records.get(prefix + '/posts/p2').body, 'keep this reply');
  assert.equal(records.get(prefix + '/posts/p2').quote, null);
  assert.equal(records.get(prefix + '/posts/p2').up, 0);
  assert.equal(records.get(prefix).accepted, ''); assert.equal(records.get(prefix).excerpt, '');
  assert(!records.has('forumHandles/' + H)); assert(!records.has('forumNames/old-handle'));
  const before = JSON.stringify([...records]); await eraseForum({ db }, 'target', async () => 'secret');
  assert.equal(JSON.stringify([...records]), before);
});
