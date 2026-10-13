import { createRequire } from 'node:module';
const { PROFILE_COLLECTION, STATE_COLLECTION } = createRequire(import.meta.url)('../_functions/candidate-access.js');
const Reveal = createRequire(import.meta.url)('../assets/oa-reveal.js');

/** Trusted builders only: no candidate names or material are committed to Pages. */
export async function readPrivateCandidates(db, { releasedOnly = false } = {}) {
  const state = await db.collection(STATE_COLLECTION).doc('current').get();
  if (!state.exists) return null; // the first build migrates the previous snapshot
  const metadata = state.data();
  if (!metadata.ready) throw new Error('Private candidate snapshot is incomplete; retry the build.');
  if (releasedOnly && !Reveal.isRevealed(metadata.revealAt)) return [];
  const snapshot = await db.collection(PROFILE_COLLECTION).where('generation', '==', metadata.generated).get();
  return snapshot.docs.map(doc => doc.data().row).filter(Boolean);
}

export async function writePrivateCandidates(db, rows, { revealAt, generated, previewTargets = {} }) {
  const collection = db.collection(PROFILE_COLLECTION);
  const state = db.collection(STATE_COLLECTION).doc('current');
  const previous = await collection.get();
  // Stage a whole generation, then switch the manifest. A failed chunk leaves
  // the last complete generation intact for both readers and the next build.
  const writes = rows.map(row => ({ ref: collection.doc(generated + '_' + row.id), row }));
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const write of writes.slice(i, i + 400)) {
      batch.set(write.ref, { row: write.row, generation: generated });
    }
    await batch.commit();
  }
  await state.set({ ready: true, revealAt, generated, count: rows.length, previewTargets });
  for (let i = 0; i < previous.docs.length; i += 400) {
    const batch = db.batch();
    for (const doc of previous.docs.slice(i, i + 400)) batch.delete(doc.ref);
    await batch.commit();
  }
}
