import { createHash } from 'node:crypto';
import { isMain } from './_main.mjs';
import { rowFromAuthUser } from './sync-user-directory.mjs';
class MergeGuardError extends Error {}
export function sameMailbox(a, b) {
  const canonical = raw => {
    const email = String(raw || '').trim().toLowerCase();
    const parts = email.split('@');
    if (parts.length !== 2) return email;
    if (['gmail.com', 'googlemail.com'].includes(parts[1])) return parts[0].split('+')[0].replace(/\./g, '') + '@gmail.com';
    return email;
  };
  return !!a && !!b && canonical(a) === canonical(b);
}
export function mergeProfile(keep = {}, duplicate = {}) {
  const result = { ...keep };
  for (const key of ['firstName', 'lastName', 'affiliation', 'website', 'contactEmail', 'orcid', 'photo']) {
    if (!String(result[key] || '').trim() && String(duplicate[key] || '').trim()) result[key] = duplicate[key];
  }
  if (result.orcid && result.orcid === duplicate.orcid && duplicate.orcidVerified) result.orcidVerified = true;
  if (!keep.orcid && duplicate.orcid) result.orcidSeeded = !!duplicate.orcidSeeded;
  if (!keep.photo && duplicate.photo) result.photoSeeded = !!duplicate.photoSeeded;
  return result;
}
export function guardMerge(keep, duplicate, kp, dp, counts) {
  const name = p => [p.firstName, p.lastName].filter(Boolean).join(' ').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!keep || !duplicate || keep.uid === duplicate.uid || keep.disabled || duplicate.disabled) throw new MergeGuardError('Two distinct active accounts are required.');
  if (!name(kp) || name(kp) !== name(dp)) throw new MergeGuardError('The names must match.');
  if (kp.orcid && dp.orcid && kp.orcid !== dp.orcid) throw new MergeGuardError('The ORCID identities conflict.');
  if (!keep.emailVerified || !keep.providerData.some(p => p.providerId === 'password')) throw new MergeGuardError('The kept account must have a verified email/password login.');
  if (!duplicate.providerData.some(p => p.providerId === 'google.com')) throw new MergeGuardError('The duplicate must have Google linked.');
  const moving = duplicate.providerData.filter(p => p.providerId !== 'password');
  if (moving.some(p => !['google.com', 'oidc.orcid'].includes(p.providerId))) throw new MergeGuardError('Unsupported provider: nothing changed.');
  if (moving.some(p => keep.providerData.some(k => k.providerId === p.providerId))) throw new MergeGuardError('The kept account already has a provider that would conflict.');
  if (Object.values(counts).some(n => n !== 0)) throw new MergeGuardError('The duplicate has content that needs a separate transfer: nothing changed.');
  return moving;
}
async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  let credential; try { credential = JSON.parse(raw); } catch { credential = JSON.parse(Buffer.from(raw || '', 'base64').toString()); }
  const { default: admin } = await import('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(credential) });
  const auth = admin.auth(), db = admin.firestore();
  const hash = email => createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex');
  const kh = process.env.KEEP_HASH, dh = process.env.DUPLICATE_HASH;
  if (!/^[a-f0-9]{64}$/.test(kh || '') || !/^[a-f0-9]{64}$/.test(dh || '') || kh === dh) throw new MergeGuardError('Two account hashes are required.');
  const journal = db.collection('accountMergeBackups').doc(kh + '-' + dh);
  const prior = (await journal.get()).data();
  if (prior && prior.status === 'complete') { console.log('This merge is already complete.'); return; }
  if (prior && prior.status !== 'rolled-back') throw new MergeGuardError('A prior attempt requires review before retrying.');
  let keep, duplicate, token;
  do {
    const page = await auth.listUsers(1000, token);
    for (const user of page.users) {
      if (hash(user.email) === kh) keep = user;
      if (hash(user.email) === dh) duplicate = user;
    }
    token = page.pageToken;
  } while (token);
  if (!keep || !duplicate) throw new MergeGuardError('Both accounts must exist.');
  const roots = ['profiles', 'registeredUsers', 'userDirectory', 'candidateMarkers', 'users', 'messages'];
  const snapshots = [];
  for (const col of roots) {
    for (const user of [keep, duplicate]) {
      const ref = db.collection(col).doc(user.uid), snap = await ref.get();
      snapshots.push({ path: ref.path, exists: snap.exists, data: snap.data() || {} });
    }
  }
  const get = (col, uid) => snapshots.find(s => s.path === col + '/' + uid).data;
  const kp = get('profiles', keep.uid), dp = get('profiles', duplicate.uid);
  const counts = {};
  for (const col of ['candidateSubmissions', 'jobSubmissions', 'placementSubmissions']) counts[col] = (await db.collection(col).where('uid', '==', duplicate.uid).get()).size;
  counts.alerts = (await db.collection('users').doc(duplicate.uid).collection('alerts').get()).size;
  counts.messages = (await db.collection('messages').doc(duplicate.uid).collection('items').get()).size;
  for (const root of ['users', 'messages']) {
    const collections = await db.collection(root).doc(duplicate.uid).listCollections();
    for (const col of collections) if (!['alerts', 'items'].includes(col.id)) counts[root + ':' + col.id] = (await col.get()).size;
  }
  const moving = guardMerge(keep, duplicate, kp, dp, counts);
  if (!moving.some(p => p.providerId === 'google.com' && sameMailbox(p.email, duplicate.email))) throw new MergeGuardError('The Google address does not match the specified duplicate.');
  const keys = await db.collection('accountKeys').where('uid', '==', duplicate.uid).get();
  const usage = await db.collection('usageSessions').where('uid', '==', duplicate.uid).get();
  const keptCandidates = await db.collection('candidateSubmissions').where('uid', '==', keep.uid).get();
  console.log(JSON.stringify({ keepPassword: true, moveProviders: moving.map(p => p.providerId),
    candidateProfilesPreserved: keptCandidates.size, duplicateContent: counts, privateBackup: true }));
  if (process.env.APPLY_MERGE !== 'true') { console.log('Plan only: nothing changed.'); return; }
  // Backup stays in Firestore's denied-by-default private space, never in GitHub.
  await journal.set({ status: 'preparing', t: Date.now(), keepUid: keep.uid, duplicateUid: duplicate.uid,
    providers: moving.map(p => ({ providerId: p.providerId, uid: p.uid, ...(p.email ? { email: p.email } : {}), ...(p.displayName ? { displayName: p.displayName } : {}), ...(p.photoURL ? { photoURL: p.photoURL } : {}) })),
    snapshots, keys: keys.docs.map(d => ({ path: d.ref.path, data: d.data() })), usagePaths: usage.docs.map(d => d.ref.path) });
  try {
    await auth.updateUser(duplicate.uid, { disabled: true });
    await auth.revokeRefreshTokens(duplicate.uid);
    for (const provider of moving) {
      await auth.updateUser(duplicate.uid, { providersToUnlink: [provider.providerId] });
      const link = { providerId: provider.providerId, uid: provider.uid };
      for (const field of ['email', 'displayName', 'photoURL']) if (provider[field]) link[field] = provider[field];
      await auth.updateUser(keep.uid, { providerToLink: link });
    }
    const verified = await auth.getUser(keep.uid);
    if (verified.email !== keep.email || verified.emailVerified !== keep.emailVerified || !verified.providerData.some(p => p.providerId === 'password')) throw new MergeGuardError('The UW login changed unexpectedly.');
    for (const provider of moving) {
      if ((await auth.getUserByProviderUid(provider.providerId, provider.uid)).uid !== keep.uid) throw new MergeGuardError('Provider link verification failed.');
    }
    await journal.update({ status: 'providers-linked' });
  } catch {
    let restored = true;
    for (const provider of moving) {
      try {
        const holder = await auth.getUserByProviderUid(provider.providerId, provider.uid).catch(() => null);
        if (holder && holder.uid === keep.uid) await auth.updateUser(keep.uid, { providersToUnlink: [provider.providerId] });
        if (!holder || holder.uid === keep.uid) await auth.updateUser(duplicate.uid, { providerToLink: { providerId: provider.providerId, uid: provider.uid, ...(provider.email ? { email: provider.email } : {}) } });
      } catch { restored = false; }
    }
    if (restored) await auth.updateUser(duplicate.uid, { disabled: false });
    await journal.update({ status: restored ? 'rolled-back' : 'review-required' });
    throw new MergeGuardError(restored ? 'Provider transfer failed; original provider links restored.' : 'Provider transfer needs recovery from the private backup.');
  }
  const combined = mergeProfile(kp, dp);
  const roster = rowFromAuthUser(await auth.getUser(keep.uid), get('userDirectory', keep.uid), combined);
  const batch = db.batch();
  batch.set(db.collection('profiles').doc(keep.uid), combined);
  if (roster) batch.set(db.collection('userDirectory').doc(keep.uid), roster);
  for (const doc of keys.docs) batch.set(doc.ref, { ...doc.data(), uid: keep.uid, t: Date.now() });
  for (const col of roots) batch.delete(db.collection(col).doc(duplicate.uid));
  await batch.commit();
  // Historical first-party page records now refer to the one surviving identity.
  for (let i = 0; i < usage.docs.length; i += 400) {
    const changes = db.batch();
    for (const doc of usage.docs.slice(i, i + 400)) changes.update(doc.ref, { uid: keep.uid });
    await changes.commit();
  }
  const candidatesAfter = await db.collection('candidateSubmissions').where('uid', '==', keep.uid).get();
  if (JSON.stringify(keptCandidates.docs.map(d => [d.id, d.data()])) !== JSON.stringify(candidatesAfter.docs.map(d => [d.id, d.data()]))) throw new MergeGuardError('Candidate data changed during the merge: review before retirement.');
  await journal.update({ status: 'data-preserved' });
  await auth.deleteUser(duplicate.uid);
  if ((await auth.getUserByEmail(keep.email)).uid !== keep.uid) throw new MergeGuardError('UW account lookup failed.');
  for (const provider of moving) if ((await auth.getUserByProviderUid(provider.providerId, provider.uid)).uid !== keep.uid) throw new MergeGuardError('Final provider lookup failed.');
  await journal.update({ status: 'complete', completedAt: Date.now() });
  console.log(JSON.stringify({ merged: true, keepPassword: true, preservedProviders: ['password', ...moving.map(p => p.providerId)],
    candidateProfilesPreserved: candidatesAfter.size, retiredDuplicate: true, privateBackup: true }));
}
if (isMain(import.meta.url)) main().catch((e) => {
  // Our own guard errors carry no personal values; SDK errors log only a code.
  const safe = e instanceof MergeGuardError;
  console.error(safe ? e.message : 'Account merge stopped (code ' + (e.code || 'unknown') + '); no personal details are logged.');
  process.exitCode = 1;
});
