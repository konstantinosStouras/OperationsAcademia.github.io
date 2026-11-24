import { accessToken, deleteFile, generateFileId, uploadFile } from './drive-upload.mjs';
import { firestore } from './_mail.mjs';
import { isMain } from './_main.mjs';

// The Firestore rules deny client access to this collection. The ID comes
// from Drive. Nothing from this collection is included in a published row.
const QUEUE = 'pendingDriveDeletions';
const HOUR = 60 * 60 * 1000;

/** Until publication commits, the uploaded copy belongs to the cleanup queue.
 * On commit, transfer ownership to the submission and queue its previous copy. */
export async function fileSubmissionUpload(db, snapshot, slot, upload) {
  const original = snapshot.data();
  const queue = db.collection(QUEUE);
  const id = await generateFileId(upload.token);
  const reservation = queue.doc(id);
  const now = Date.now();
  const record = { uid: original.uid || '', source: snapshot.ref.path, createdAt: now };
  // Longer than the workflow timeout and the HTTP upload deadline. Even a
  // crash before Drive receives the POST is recoverable (DELETE returns 404).
  await reservation.create({ ...record, retryAt: now + HOUR });
  const result = await uploadFile({ ...upload, id });
  if (result.id !== id || !result.webViewLink) throw new Error('Drive returned an incomplete upload receipt');

  const patch = {
    [slot.url]: result.webViewLink, [slot.driveId]: id,
    [slot.path]: null, [slot.name]: null, [slot.type]: null, [slot.size]: null,
  };
  return db.runTransaction(async tx => {
    const current = (await tx.get(snapshot.ref)).data();
    const reserved = (await tx.get(reservation)).data();
    if (!reserved || reserved.deleting || reserved.retryAt <= Date.now()) return null;
    if (!current || current.uid !== original.uid || !['queued', 'published'].includes(current.status)
        || current[slot.path] !== original[slot.path] || current[slot.url]) {
      // A withdrawal, another upload, or a competing publisher won the race.
      tx.update(reservation, { retryAt: 0 });
      return null;
    }
    const oldId = current[slot.driveId];
    if (oldId && oldId !== id) {
      tx.set(queue.doc(oldId), { ...record, retryAt: 0 });
    }
    tx.update(snapshot.ref, patch);
    tx.delete(reservation);
    return patch;
  });
}

/** One attempt per due file. Each failure moves the retry time forward.
 * DELETE treats 404 as success, including when a previous worker deleted
 * the file and crashed before acknowledging it in Firestore. */
export async function drainDriveDeletions(db, { uid, source, now = Date.now() } = {}) {
  const queue = db.collection(QUEUE);
  let query = queue.where('retryAt', '<=', now).limit(100);
  if (uid !== undefined) query = queue.where('uid', '==', uid);
  if (source) query = queue.where('source', '==', source);
  const { docs } = await query.get();
  const due = docs.filter(d => d.data().retryAt <= now);
  let remaining = docs.length;
  if (!due.length) return remaining;
  const token = await accessToken();
  if (!token) throw new Error('Drive cleanup credentials are missing');
  for (const doc of due) {
    const item = await db.runTransaction(async tx => {
      const current = (await tx.get(doc.ref)).data();
      if (!current || current.retryAt > now) return null;
      tx.update(doc.ref, { deleting: true, retryAt: now + HOUR });
      return current;
    });
    if (!item) continue;
    try {
      await deleteFile({ token, id: doc.id });
    } catch (error) {
      const attempts = (item.attempts || 0) + 1;
      const delay = Math.min(24 * HOUR, 60_000 * 2 ** Math.min(attempts, 11));
      // A concurrent purge may already have removed the record. An update
      // can fail in that case, but cannot recreate completed work.
      try {
        await doc.ref.update({ attempts, retryAt: now + delay });
      } catch (writeError) {
        if (writeError.code !== 5) throw writeError;
      }
      console.warn(`::warning::Drive deletion deferred after attempt ${attempts} (HTTP ${error.status || 'unavailable'}).`);
      continue;
    }
    await doc.ref.delete();
    remaining--;
  }
  return remaining;
}

export async function checkDriveDeletions(db) {
  await drainDriveDeletions(db);
  const overdue = await db.collection(QUEUE).where('createdAt', '<=', Date.now() - 24 * HOUR).limit(1).get();
  if (!overdue.empty) {
    throw new Error('Drive deletion has been pending for at least 24 hours. Check the private pendingDriveDeletions queue and Drive credentials.');
  }
}

if (isMain(import.meta.url)) {
  const db = await firestore();
  if (!db) throw new Error('Cannot check Drive cleanup without Firestore credentials');
  await checkDriveDeletions(db);
}
