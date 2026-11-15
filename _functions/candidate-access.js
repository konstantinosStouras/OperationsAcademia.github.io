'use strict';

// No Firestore client read rule exposes these collections. Only this callable
// reads the snapshot, after Firebase has verified the caller's identity.
const PROFILE_COLLECTION = 'privateCandidateProfiles';
const STATE_COLLECTION = 'privateCandidateState';
const FIELDS = ['id', 'year', 'posted', 'first', 'last', 'name', 'affiliation', 'position',
  'researchAreas', 'informsDays', 'talks', 'jobTalk', 'informsUrl', 'cvUrl', 'rsUrl', 'webUrl', 'email',
  'source', 'addedAt', 'updatedAt', 'ref', 'owner'];

function createReader({ db, HttpsError, revealed }) {
  // Generations are immutable. Reuse only their projected rows in this server
  // instance; never cache admission, the current manifest or the reveal gate.
  let cached = null;
  function readGeneration(database, generation) {
    if (cached && cached.generation === generation) return cached.promise;
    const entry = { generation };
    cached = entry;
    entry.promise = database.collection(PROFILE_COLLECTION).where('generation', '==', generation).get()
      .then(snapshot => snapshot.docs.map(doc => {
        const source = doc.data().row || {};
        const row = {};
        for (const field of FIELDS) if (Object.hasOwn(source, field)) row[field] = source[field];
        return row;
      })).catch(error => {
        if (cached === entry) cached = null;
        throw error;
      });
    return entry.promise;
  }
  return async function (request) {
    if (!request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Sign in to view candidate profiles.');
    const token = request.auth.token || {};
    if (token.firebase && token.firebase.sign_in_provider === 'anonymous') {
      throw new HttpsError('permission-denied', 'Create an account before viewing candidate profiles.');
    }
    if (token.firebase && token.firebase.sign_in_provider === 'password' && token.email_verified !== true) {
      throw new HttpsError('permission-denied', 'Verify your email before viewing candidate profiles.');
    }
    const database = db();
    const [, state] = await Promise.all([
      require('./account-access').assertActive(database, request.auth.uid, HttpsError),
      database.collection(STATE_COLLECTION).doc('current').get(),
    ]);
    if (!state.exists || !state.data().ready) throw new HttpsError('unavailable', 'Candidate profiles are being updated. Please try again shortly.');
    const metadata = state.data();
    if (!revealed(metadata.revealAt)) return { rows: [] };
    // A previously validated immutable snapshot is already complete. The live
    // manifest and account block above are the only reads a cache hit needs.
    if (cached && cached.generation === metadata.generated && cached.rows) {
      return { rows: cached.rows, previewTargets: metadata.previewTargets || {} };
    }
    const rows = await readGeneration(database, metadata.generated);
    // If a build began while this request was reading, fail closed rather than
    // returning a partial or mixed snapshot.
    const check = await database.collection(STATE_COLLECTION).doc('current').get();
    if (!check.exists || !check.data().ready || check.data().generated !== metadata.generated ||
        !revealed(check.data().revealAt)) {
      cached = null;
      throw new HttpsError('unavailable', 'Candidate profiles are being updated.');
    }
    if (cached && cached.generation === metadata.generated) cached.rows = rows;
    return { rows, previewTargets: metadata.previewTargets || {} };
  };
}

module.exports = { createReader, PROFILE_COLLECTION, STATE_COLLECTION, FIELDS };
