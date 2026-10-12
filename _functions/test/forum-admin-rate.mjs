import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const P = require('../forum/member.js');
const M = require('../forum-model.js');
const source = readFileSync(new URL('../forum/post.js', import.meta.url), 'utf8');
const now = M.minute();
const adminToken = { email: 'kstouras@gmail.com', email_verified: true };
assert.equal(P.adminToken(adminToken), true);
assert.equal(P.adminToken({ ...adminToken, email_verified: false }), false);
assert.equal(P.adminToken({ email: 'member@example.org', email_verified: true, isAdmin: true }), false);

async function post({ token = {}, reply = false, counters = {}, locked = false, body = 'A useful question for the community.', spoof = false } = {}) {
  const writes = [];
  const ref = (path) => ({ path, id: path.split('/').at(-1), collection: (s) => ref(path + '/' + s),
    doc: (s = 'new-id') => ref(path + '/' + s), where: () => ({ limit: () => ({ head: true }) }) });
  const D = { collection: ref };
  const hv = { guideAt: now, day: M.today(now), dayThreads: 3, dayPosts: 40, dayVotes: 9, lastPostAt: now, ...counters };
  const tx = {
    get: async (r) => r.head ? { empty: false, docs: [{ data: () => ({ body: 'Original question.', hidden: false }) }] }
      : { exists: true, data: () => r.path === 'handle' ? hv : r.path.startsWith('forumTags') ? { counts: {} }
        : { season: 2027, n: 2, locked, hidden: false } },
    set: (r, d) => writes.push({ path: r.path, data: d }),
    update: (r, d) => writes.push({ path: r.path, data: d }),
  };
  const member = { ...P, member: async () => ({ D, Y: 2027, ref: ref('handle'), handle: 'steady reed 12', isAdmin: P.adminToken(token) }),
    run: async (_, fn) => fn(tx) };
  const exports = {};
  vm.runInNewContext(source, { exports, require: (id) => id === './member.js' ? member
    : id === 'firebase-functions/v2/https' ? { onCall: (_, handler) => handler } : require(id.startsWith('../') ? '../forum/' + id : id) });
  const result = await exports.forumPost({ auth: { token }, data: { room: 'candidates', ...(reply ? { tid: 'existing' } : {}),
    title: 'A test question', tags: ['interviews'], body, isAdmin: spoof } });
  return { result, writes };
}

for (const reply of [false, true]) {
  const r = await post({ token: adminToken, reply });
  assert.ok(r.result.pid);
  const count = r.writes.find((w) => w.path === 'handle').data;
  assert.equal(count.dayPosts, 41);
  assert.equal(count.dayThreads, reply ? 3 : 4);
  assert.equal(count.dayVotes, 9);
}
const rejected = async (options, reason) => assert.rejects(post(options), (e) => e.details?.reason === reason);
await rejected({ spoof: true }, 'threads');
await rejected({ reply: true, spoof: true }, 'posts');
await rejected({ counters: { dayThreads: 0, dayPosts: 0 } }, 'gap');
await rejected({ reply: true, counters: { dayThreads: 0, dayPosts: 0 } }, 'gap');
await rejected({ token: { ...adminToken, email_verified: false } }, 'threads');
await rejected({ token: adminToken, reply: true, locked: true }, 'locked');
await assert.rejects(post({ token: adminToken, body: 'Email someone@example.org' }));
await rejected({ token: adminToken, body: '' }, 'bounds');
for (const reply of [false, true]) {
  assert.ok((await post({ reply, counters: { dayThreads: 0, dayPosts: 0, lastPostAt: 0 } })).result.pid);
}
console.log('PASS: verified-admin posting exemption, unchanged member limits, forged-role rejection, counters, content and lock guards.');
