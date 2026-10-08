import { sameMailbox } from './merge-account-identities.mjs';
import { createHash } from 'node:crypto';
const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
let credential; try { credential = JSON.parse(raw); } catch { credential = JSON.parse(Buffer.from(raw || '', 'base64').toString()); }
const { default: admin } = await import('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(credential) });
const auth = admin.auth(), db = admin.firestore();
const hash = email => createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex');
const keepHash = process.env.KEEP_HASH, duplicateHash = process.env.DUPLICATE_HASH;
if (!/^[a-f0-9]{64}$/.test(keepHash || '') || !/^[a-f0-9]{64}$/.test(duplicateHash || '') || keepHash === duplicateHash) throw new Error('Two distinct account hashes are required.');
let keeper, duplicate, token;
do {
  const page = await auth.listUsers(1000, token);
  for (const user of page.users) {
    if (hash(user.email) === keepHash) keeper = user;
    if (hash(user.email) === duplicateHash) duplicate = user;
  }
  token = page.pageToken;
} while (token);
if (!keeper || !duplicate) throw new Error('Both specified accounts must exist.');
const profile = async u => (await db.collection('profiles').doc(u.uid).get()).data() || {};
const [kp, dp] = await Promise.all([profile(keeper), profile(duplicate)]);
const normalize = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const name = p => normalize(p.displayName || p.name || [p.firstName, p.lastName].filter(Boolean).join(' '));
const counts = async uid => {
  const out = {};
  for (const col of ['candidateSubmissions', 'jobSubmissions', 'placementSubmissions']) out[col] = (await db.collection(col).where('uid', '==', uid).get()).size;
  out.alerts = (await db.collection('users').doc(uid).collection('alerts').get()).size;
  out.messages = (await db.collection('messages').doc(uid).collection('items').get()).size;
  return out;
};
console.log(JSON.stringify({ keeper: { providers: keeper.providerData.map(p => p.providerId), emailVerified: keeper.emailVerified, disabled: keeper.disabled, content: await counts(keeper.uid) },
  duplicate: { providers: duplicate.providerData.map(p => p.providerId), emailVerified: duplicate.emailVerified, disabled: duplicate.disabled, content: await counts(duplicate.uid) },
  sameName: !!name(kp) && name(kp) === name(dp), conflictingOrcid: !!kp.orcid && !!dp.orcid && kp.orcid !== dp.orcid,
  googleMailboxMatchesPrimary: duplicate.providerData.some(p => p.providerId === 'google.com' && sameMailbox(p.email, duplicate.email)),
  inspectedOnly: true }));
