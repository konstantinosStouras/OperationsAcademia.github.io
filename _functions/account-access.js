'use strict';

const { createHash } = require('node:crypto');
const ADMIN = 'kstouras@gmail.com';

function emailKey(email) {
  let value = String(email || '').trim().toLowerCase();
  // Gmail aliases belong to the same mailbox. Other providers keep their dots.
  const parts = value.split('@');
  if (parts.length === 2 && ['gmail.com', 'googlemail.com'].includes(parts[1])) {
    value = parts[0].split('+')[0].replace(/\./g, '') + '@gmail.com';
  }
  return value ? digest('email', value) : null;
}
function digest(type, value) {
  return createHash('sha256').update(type + ':' + value).digest('hex');
}
function identityKeys(user) {
  const keys = [emailKey(user.email)];
  for (const provider of user.providerData || []) {
    keys.push(emailKey(provider.email));
    if (provider.providerId && provider.uid) keys.push(digest(provider.providerId, provider.uid));
  }
  return [...new Set(keys.filter(Boolean))];
}
async function assertActive(db, uid, HttpsError) {
  if ((await db.collection('accountBlocks').doc(uid).get()).exists) {
    throw new HttpsError('permission-denied', 'This account no longer has member access.');
  }
}
async function checkIdentity(db, user, HttpsError) {
  if (user.uid) await assertActive(db, user.uid, HttpsError);
  const refs = identityKeys(user).map(key => db.collection('blockedIdentities').doc(key));
  if (refs.length && (await db.getAll(...refs)).some(s => s.exists)) {
    throw new HttpsError('permission-denied', 'Registration or sign-in is unavailable for this account.');
  }
}

// Server-derived identities only. The client supplies a UID, never an email
// to ban. The block and durable work order commit together, before Auth work.
async function queueDeletion({ db, auth, HttpsError }, uid, by = 'admin') {
  if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.includes('/')) {
    throw new HttpsError('invalid-argument', 'Choose an account to delete.');
  }
  let user;
  try { user = await auth.getUser(uid); }
  catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
  if (user && (emailKey(user.email) === emailKey(ADMIN) ||
      (user.providerData || []).some(p => emailKey(p.email) === emailKey(ADMIN)))) {
    throw new HttpsError('failed-precondition', 'The maintainer account cannot be deleted here.');
  }
  const now = Date.now();
  await db.runTransaction(async tx => {
    const ref = db.collection('accountDeletions').doc(uid);
    const previous = await tx.get(ref);
    if (!user && !previous.exists) throw new HttpsError('not-found', 'Account not found.');
    const order = previous.exists ? previous.data() : { uid, by, askedAt: now, status: 'requested' };
    tx.set(db.collection('accountBlocks').doc(uid), { blocked: true });
    if (by === 'admin' && user) {
      for (const key of identityKeys(user)) tx.set(db.collection('blockedIdentities').doc(key), { blocked: true });
    }
    if (order.status !== 'done') {
      // Preserve the authoritative identity until the worker removes its keys.
      tx.set(ref, { ...order, by, accessBlockedAt: order.accessBlockedAt || now,
        ...(user && user.email ? { email: user.email } : {}) });
    }
  });
  if (user) {
    try {
      await auth.updateUser(uid, { disabled: true });
      await auth.revokeRefreshTokens(uid);
    } catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
  }
  return { uid, accessBlocked: true };
}

function createAdminDelete(deps) {
  return async request => {
    const caller = request.auth;
    if (!caller || !caller.uid) throw new deps.HttpsError('unauthenticated', 'Sign in first.');
    if (caller.token.email !== ADMIN || caller.token.email_verified !== true) {
      throw new deps.HttpsError('permission-denied', 'Only the maintainer can delete another account.');
    }
    await assertActive(deps.db, caller.uid, deps.HttpsError);
    return queueDeletion(deps, request.data && request.data.uid);
  };
}
module.exports = { emailKey, identityKeys, assertActive, checkIdentity, queueDeletion, createAdminDelete };
