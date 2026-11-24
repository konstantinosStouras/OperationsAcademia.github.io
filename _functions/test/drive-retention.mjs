import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { transferUploads } from '../../_scraper/build-candidates.mjs';
import { killDriveCopies } from '../../_scraper/purge-accounts.mjs';
import { drainDriveDeletions } from '../../_scraper/drive-retention.mjs';

assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^(localhost|127\.0\.0\.1):\d+$/);
const app = initializeApp({ projectId: 'demo-oa-rules' });
const db = getFirestore(app);
const uid = 'drive-test-owner';
const ref = db.collection('candidateSubmissions').doc('cv-replacement-test');
const queue = db.collection('pendingDriveDeletions');
const old = queue.doc('test-old-cv');
const fresh = queue.doc('test-new-cv');
const landingPath = 'uploads/' + uid + '/candidates/replacement.pdf';
const newUrl = 'https://drive.google.com/open?id=' + fresh.id;
const deleted = [];
const responses = [];
let creates = 0;
let storageDeletes = 0;
let nextId = fresh.id;
let afterUpload = async () => {};
let uploadStatus = 200;
const loadBucket = () => ({
  file(path) {
    assert.equal(path, landingPath);
    return { download: async () => [Buffer.from('synthetic CV')], delete: async () => { storageDeletes++; } };
  },
});
// Replace every external Drive/token request. The real transaction, queue,
// candidate publisher, HTTP response handling and purge run unchanged.
delete process.env.FIREBASE_SERVICE_ACCOUNT;
for (const key of ['GDRIVE_CLIENT_ID', 'GDRIVE_CLIENT_SECRET', 'GDRIVE_REFRESH_TOKEN']) process.env[key] = 'test';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const { origin, pathname } = new URL(url);
  if (origin === 'https://oauth2.googleapis.com' && pathname === '/token') {
    return Response.json({ access_token: 'fake' });
  }
  assert.equal(origin, 'https://www.googleapis.com');
  if (pathname.endsWith('/generateIds')) return Response.json({ ids: [nextId] });
  if (pathname === '/upload/drive/v3/files' && options.method === 'POST') {
    creates++;
    assert.ok((await queue.doc(nextId).get()).exists, 'ID recorded before upload');
    assert.ok(options.body.toString().includes(JSON.stringify(nextId)));
    await afterUpload();
    if (uploadStatus !== 200) return new Response(null, { status: uploadStatus });
    return Response.json({ id: nextId, webViewLink: newUrl });
  }
  assert.equal(options.method, 'DELETE');
  const id = pathname.split('/').pop();
  deleted.push(id);
  const [expected, status] = responses.shift() || [];
  assert.equal(id, expected);
  return new Response(status === 403 ? '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}' : null, { status });
};

const now = new Date('2026-11-24T12:00:00Z');
const seed = { uid, ref: 'test-profile', status: 'published', cvUrl: '', cvDriveId: old.id,
  cvUploadPath: landingPath, cvUploadName: 'replacement.pdf' };
const publish = async () => transferUploads(db, [await ref.get()], { now, loadBucket });
const held = async () => ({ candidateSubmissions: [{ id: ref.id, data: (await ref.get()).data() }] });
try {
  await ref.set(seed);
  const patches = await publish();
  assert.equal(patches.get(ref.id).cvUrl, newUrl);
  const current = (await ref.get()).data();
  assert.equal(current.cvDriveId, fresh.id);
  assert.equal(current.cvUploadPath, null);
  assert.equal(storageDeletes, 1);
  assert.equal((await fresh.get()).exists, false);
  assert.equal((await old.get()).data().uid, uid);

  responses.push([old.id, 429]);
  assert.equal(await drainDriveDeletions(db), 1);
  const retryAt = (await old.get()).data().retryAt;
  assert.equal((await ref.get()).data().cvUrl, newUrl);
  assert.equal(await killDriveCopies(db, uid, await held()), null, 'quota delay holds account deletion open');
  await publish();
  assert.equal(creates, 1, 'an idle build does not upload the replacement again');
  responses.push([old.id, 403]);
  assert.equal(await drainDriveDeletions(db, { now: retryAt }), 1);
  const later = (await old.get()).data().retryAt;
  assert.ok(later > retryAt);
  responses.push([old.id, 204]);
  assert.equal(await drainDriveDeletions(db, { now: later }), 0);
  assert.equal((await old.get()).exists, false);
  assert.deepEqual(deleted, [old.id, old.id, old.id]);
  assert.equal((await ref.get()).data().cvDriveId, fresh.id);

  // A lost acknowledgement replays a successful DELETE. Purge accepts
  // "already gone" and then removes the current upload as well.
  await old.set({ uid, source: ref.path, retryAt: 0, createdAt: 0 });
  responses.push([old.id, 404], [fresh.id, 204]);
  assert.equal(await killDriveCopies(db, uid, await held()), 1);
  assert.equal((await old.get()).exists, false);

  // A withdrawal between upload and publication must preserve the old link
  // and retain the newly uploaded, unpublished file for cleanup.
  await ref.set(seed);
  nextId = 'test-stale-upload';
  afterUpload = () => ref.update({ status: 'withdrawn' });
  assert.equal((await publish()).size, 0);
  assert.equal((await ref.get()).data().cvDriveId, old.id);
  assert.equal(storageDeletes, 1);
  responses.push([nextId, 204]);
  assert.equal(await drainDriveDeletions(db), 0);

  // Google may throttle the upload itself before a replacement link exists.
  // Keep the source bytes and the old Drive ID, then file once service resumes.
  await ref.set(seed);
  nextId = 'test-refused-upload';
  afterUpload = async () => {};
  uploadStatus = 429;
  assert.equal((await publish()).size, 0);
  const pending = (await ref.get()).data();
  assert.equal(pending.cvUploadPath, landingPath);
  assert.equal(pending.cvDriveId, old.id);
  assert.equal(storageDeletes, 1);
  assert.equal((await old.get()).exists, false);
  const reservation = queue.doc(nextId);
  const expiry = (await reservation.get()).data().retryAt;
  nextId = fresh.id;
  uploadStatus = 200;
  assert.equal((await publish()).get(ref.id).cvUrl, newUrl);
  responses.push([old.id, 204]);
  await drainDriveDeletions(db);
  responses.push([reservation.id, 404]);
  assert.equal(await drainDriveDeletions(db, { now: expiry }), 0);
  assert.equal((await ref.get()).data().cvDriveId, fresh.id);
  assert.equal(responses.length, 0);
  console.log('Drive retention passed: upload and deletion throttles, both retries, purge hold, 404 replay, concurrent withdrawal.');
} finally {
  globalThis.fetch = realFetch;
  await Promise.all([ref, old, fresh, queue.doc('test-stale-upload'), queue.doc('test-refused-upload')].map(doc => doc.delete()));
  await deleteApp(app);
}
