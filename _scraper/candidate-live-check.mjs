// Manual deployment check. Credentials and identity tokens never enter logs.
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readPrivateCandidates } from './private-candidates.mjs';
import { readFile } from 'node:fs/promises';

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  let credentials;
  try { credentials = JSON.parse(raw); }
  catch { credentials = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
  if (credentials.project_id !== 'operations-academia') throw new Error('Wrong Firebase project.');
  const app = initializeApp({ credential: cert(credentials) });
  const rows = await readPrivateCandidates(getFirestore(app), { releasedOnly: true });
  if (!rows || !rows.length) throw new Error('No released private snapshot.');
  const endpoint = 'https://us-central1-operations-academia.cloudfunctions.net/readCandidateProfiles';
  const call = token => fetch(endpoint, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {})
  }, body: JSON.stringify({ data: {} }) });
  const publicResponse = await call();
  if (publicResponse.status !== 401) throw new Error('Reader did not refuse a signed-out request.');
  const auth = getAuth(app);
  const maintainer = await auth.getUserByEmail('kstouras@gmail.com');
  const token = await auth.createCustomToken(maintainer.uid);
  const config = await readFile(new URL('../assets/oa-firebase.js', import.meta.url), 'utf8');
  const key = config.match(/apiKey:\s*'([^']+)'/)[1];
  const signIn = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=' + key, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, returnSecureToken: true })
  });
  const identity = await signIn.json();
  if (!signIn.ok || !identity.idToken) throw new Error('Registered test sign-in failed.');
  const response = await call(identity.idToken);
  const result = await response.json();
  const served = result.result && result.result.rows;
  if (!response.ok || !Array.isArray(served) || served.length !== rows.length ||
      rows.some(row => !served.some(candidate => candidate.id === row.id))) {
    throw new Error('Registered reader did not return the complete private snapshot.');
  }
  console.log('Live candidate access passed: signed-out requests refused; registered account receives all ' + served.length + ' profiles.');
}
main().catch(error => {
  // Admin errors may embed request headers; print only the safe message.
  console.error('Candidate reader verification failed: ' + (error.code || error.message));
  process.exitCode = 1;
});
