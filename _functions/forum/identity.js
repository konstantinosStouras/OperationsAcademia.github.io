/* ---------------------------------------------------------------------------
   The forum's identity: the ONE computation over a uid, the handle draw, and
   the season's secret version.

   H = HMAC-SHA256(FORUM_SECRET[version], season + ':' + uid), lower-case hex,
   64 characters, used WHOLE. Nothing else in the forum ever computes over a
   uid (the selftest scans for it), nothing truncates H, and the display
   handle is drawn at random rather than derived from anything: a reader who
   knows every handle on the site learns nothing about H, and a reader who
   knows every uid learns nothing without the secret.

   THE SECRET IS VERSIONED BY SEASON (the privacy audit's one change). The
   season document names the Secret Manager VERSION its handles are derived
   under (`forumSeasons/{Y}.secretVersion`), written on the season's first
   join from whatever `latest` resolved to at that moment; every later call
   reads exactly that version, never `latest` and never another season's.
   The 1 August housekeeping (step 2) destroys the previous season's version
   and stamps `secretDestroyedAt`, after which that season's H cannot be
   re-derived by anyone. `defineSecret` on the callables grants the runtime
   account access to the secret; `@google-cloud/secret-manager` is what reads
   a NAMED version, which `.value()` cannot.

   THE EMULATOR HAS NO SECRET MANAGER. Under the Functions emulator only
   (`FUNCTIONS_EMULATOR === 'true'`), the versions `env` and `env2` are read
   from FORUM_SECRET_TEST and FORUM_SECRET_TEST_2, and `latest` resolves to
   `env`; the two-version emulator check proves two versions give two handles
   for one uid. The branch is guarded on that variable and nothing else.
   --------------------------------------------------------------------------- */

'use strict';

const crypto = require('node:crypto');
const { ADJ, NOUN, RESERVED } = require('./words.js');
const M = require('../forum-model.js');

const SECRET_NAME = 'FORUM_SECRET';

/** The one HMAC. */
function hashFor(secret, season, uid) {
  return crypto.createHmac('sha256', String(secret))
    .update(String(season) + ':' + String(uid))
    .digest('hex');
}

/** A display handle, drawn at random from the word lists. Takes nothing and
    derives from nothing: not H, not the uid, not the clock. */
function drawHandle() {
  const adj = ADJ[crypto.randomInt(ADJ.length)];
  const noun = NOUN[crypto.randomInt(NOUN.length)];
  const num = crypto.randomInt(10, 100);
  return adj + ' ' + noun + ' ' + num;
}

function reserved(slug) {
  return RESERVED.indexOf(slug) !== -1;
}

function emulated() {
  return process.env.FUNCTIONS_EMULATOR === 'true';
}

function projectId() {
  return process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '';
}

let smClient = null;

/** Read ONE version of the secret: `{ version, payload }`, the version being
    the number the manager resolved (so `latest` comes back as a number a
    season document can carry). */
async function accessVersion(version) {
  if (emulated()) {
    const v = version === 'latest' ? 'env' : String(version);
    const key = v === 'env' ? 'FORUM_SECRET_TEST' : v === 'env2' ? 'FORUM_SECRET_TEST_2' : '';
    const payload = key ? process.env[key] : '';
    if (!payload) throw new Error('emulator: no test secret for version ' + v);
    return { version: v, payload };
  }
  const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
  smClient = smClient || new SecretManagerServiceClient();
  const name = 'projects/' + projectId() + '/secrets/' + SECRET_NAME + '/versions/' + version;
  const [res] = await smClient.accessSecretVersion({ name });
  const resolved = String(res.name || '').split('/').pop() || String(version);
  return { version: resolved, payload: res.payload.data.toString('utf8') };
}

const cache = new Map();

/** The season head, created on first use with the version `latest` resolves
    to at that moment. Returns the document's data. */
async function ensureSeason(db, season) {
  const ref = db.collection('forumSeasons').doc(String(season));
  const snap = await ref.get();
  if (snap.exists && snap.data().secretVersion) return snap.data();
  /* the create branch: the ONE place `latest` is named */
  const fresh = await accessVersion('latest');
  cache.set(season + ':' + fresh.version, fresh.payload);
  return db.runTransaction(async (tx) => {
    const again = await tx.get(ref);
    if (again.exists && again.data().secretVersion) return again.data();
    /* @doc season */
    const head = {
      season: Number(season),
      createdAt: M.minute(),
      secretVersion: fresh.version,
      guides: {},
    };
    /* @end */
    tx.set(ref, head, { merge: true });
    return head;
  });
}

/** The secret the given season's handles are derived under: the version its
    own document names, and no other season's. */
async function secretForSeason(db, season) {
  const head = await ensureSeason(db, season);
  const key = season + ':' + head.secretVersion;
  if (cache.has(key)) return cache.get(key);
  const got = await accessVersion(head.secretVersion);
  cache.set(key, got.payload);
  return got.payload;
}

module.exports = { hashFor, drawHandle, reserved, ensureSeason, secretForSeason, SECRET_NAME };
