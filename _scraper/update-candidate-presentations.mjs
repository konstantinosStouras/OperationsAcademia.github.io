import admin from 'firebase-admin';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Calendar = require('../assets/oa-candidate-calendar.js');
const raw = process.env.OA_CANDIDATE_PRESENTATION_UPDATES;
if (!raw) throw new Error('Missing private update payload');
let credentials;
try { credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); }
catch { credentials = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT || '', 'base64').toString()); }
if (credentials.project_id !== 'operations-academia') throw new Error('Wrong Firebase project');
admin.initializeApp({ credential: admin.credential.cert(credentials) });
const db = admin.firestore();
const updates = JSON.parse(raw);
if (!Array.isArray(updates) || updates.length > 32) throw new Error('Invalid update count');
const snapshot = await db.collection('candidateSubmissions').get();
const normalized = s => String(s || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const names = new Set();
const plans = updates.map(update => {
  const name = normalized(update.name);
  if (!name || names.has(name)) throw new Error('Missing or duplicate candidate name');
  names.add(name);
  const matches = snapshot.docs.filter(doc => {
    const v = doc.data();
    return Number(v.year) === 2027 && normalized(v.name || [v.first, v.last].filter(Boolean).join(' ')) === name
      && !['withdrawn', 'hidden', 'rejected'].includes(v.status);
  });
  if (matches.length !== 1) throw new Error('A candidate did not match exactly one active profile; no writes made');
  const doc = matches[0], current = doc.data(), patch = {};
  if (update.jobTalk) {
    if (!Calendar.presentationUrl(update.informsUrl)) throw new Error('Invalid presentation URL');
    patch.jobTalk = update.jobTalk;
    patch.informsUrl = update.informsUrl;
    patch.informsDays = [...new Set([...(current.informsDays || []), update.programmeDay])];
    if (!Calendar.event({ ...current, ...patch, id: doc.id,
      name: current.name || [current.first, current.last].filter(Boolean).join(' ') })) throw new Error('Incomplete presentation');
  }
  if (update.unit) patch.unit = update.unit;
  return { ref: doc.ref, current, patch };
});
if (process.env.OA_APPLY_UPDATES !== 'true') {
  console.log(`Validated ${plans.length} exact profile matches; no changes saved.`);
} else {
  await db.runTransaction(async tx => {
    const fresh = await Promise.all(plans.map(plan => tx.get(plan.ref)));
    for (let i = 0; i < plans.length; i++) {
      if (JSON.stringify(fresh[i].data()) !== JSON.stringify(plans[i].current)) throw new Error('A profile changed during review; no writes made');
    }
    for (const plan of plans) tx.update(plan.ref, { ...plan.patch, updatedAt: new Date().toISOString() });
  });
  const saved = await Promise.all(plans.map(plan => plan.ref.get()));
  for (let i = 0; i < plans.length; i++) {
    const expected = { ...plans[i].current, ...plans[i].patch };
    const actual = saved[i].data();
    delete expected.updatedAt; delete actual.updatedAt;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      // Firestore can return map keys in a different order; compare each field.
      const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' && !value.toDate
        ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;
      if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(expected))) throw new Error('Saved profile did not match the intended patch');
    }
  }
  console.log(`Updated and verified ${saved.length} profiles. Status, ownership, documents and reveal settings preserved.`);
}
