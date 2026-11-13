'use strict';
const { createHmac } = require('node:crypto');

// recursiveDelete also finds subcollections whose parent document is absent.
// Never swallow errors: the work order must remain retryable until all erase.
async function eraseTree(db, ref) {
  await db.recursiveDelete(ref);
}

async function eraseUploads(bucket, uid) {
  if (!bucket) throw new Error('Storage is unavailable; deletion remains open');
  const [files] = await bucket.getFiles({ prefix: `uploads/${uid}/`, versions: true });
  for (const file of files) await file.delete({ ignoreNotFound: true });
  return files.length;
}

async function seasonSecret(fb, version) {
  const credential = fb.auth.app.options.credential;
  const token = await credential.getAccessToken();
  const project = fb.auth.app.options.projectId || credential.projectId;
  if (!project) throw new Error('Missing project for forum erasure');
  const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/FORUM_SECRET/versions/${version}`;
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const response = await fetch(url + ':access', { headers });
  if (!response.ok) {
    const error = await response.json();
    if (error.error?.status === 'FAILED_PRECONDITION' && /DESTROYED/.test(error.error.message || '')) return null;
    throw new Error('Could not read forum secret: ' + response.status);
  }
  return Buffer.from((await response.json()).payload.data, 'base64').toString();
}

async function eraseForum(fb, uid, readSecret = seasonSecret) {
  const db = fb.db;
  let count = 0;
  for (const season of (await db.collection('forumSeasons').get()).docs) {
    const version = season.data().secretVersion;
    if (!version) continue;
    const secret = await readSecret(fb, version);
    if (secret === null) continue;
    const key = createHmac('sha256', secret).update(season.id + ':' + uid).digest('hex');
    const handleRef = db.collection('forumHandles').doc(key);
    const handle = await handleRef.get();
    if (!handle.exists) continue;
    const name = handle.data().handle;
    for (const room of ['open', 'candidates']) {
      const threads = await season.ref.collection('rooms').doc(room).collection('threads').get();
      for (const thread of threads.docs) {
        const posts = await thread.ref.collection('posts').get();
        for (const post of posts.docs) {
          // Removing a vote and its counters is one transaction, so retries
          // cannot subtract it twice. Preserve other members' replies/votes.
          await db.runTransaction(async tx => {
            const voteRef = post.ref.collection('votes').doc(key);
            const [current, vote, head] = await Promise.all([tx.get(post.ref), tx.get(voteRef), tx.get(thread.ref)]);
            if (!current.exists) return;
            const pv = current.data();
            const patch = {};
            if (pv.by === name) Object.assign(patch, { body: '', by: '', quote: null, hidden: true, hiddenBy: 'author' });
            else if (pv.quote && pv.quote.by === name) patch.quote = null;
            if (vote.exists) {
              const v = Number(vote.data().v) || 0;
              patch.up = Math.max(0, (Number(pv.up) || 0) - (v === 1 ? 1 : 0));
              patch.down = Math.max(0, (Number(pv.down) || 0) - (v === -1 ? 1 : 0));
              if (Number(pv.n) === 1 && head.exists) tx.update(thread.ref, { score: patch.up - patch.down });
              tx.delete(voteRef);
            }
            if (Object.keys(patch).length) tx.update(post.ref, patch);
            if (head.exists && head.data().accepted === post.id && pv.by === name) tx.update(thread.ref, { accepted: '' });
          });
          if (post.data().by === name) count++;
        }
        // Re-read: votes may have updated the head above.
        const current = await thread.ref.get();
        if (!current.exists) continue;
        const tv = current.data(), patch = {};
        if (tv.by === name) Object.assign(patch, { by: '', title: 'Deleted question', excerpt: '', locked: true });
        if (tv.lastBy === name) patch.lastBy = '';
        if (Object.keys(patch).length) await thread.ref.update(patch);
      }
    }
    const names = await db.collection('forumNames').where('key', '==', key).get();
    for (const doc of names.docs) await eraseTree(db, doc.ref);
    // Keep the handle until every post, quote and vote has been processed,
    // so an interrupted cleanup can still find its remaining content.
    await eraseTree(db, handleRef);
  }
  return count;
}

module.exports = { eraseTree, eraseUploads, eraseForum };
