/** Job-specific retention policy. No database or network access here. */
export const RETENTION_DAYS = 30;
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const DOWN_STATUSES = ['hidden', 'withdrawn', 'removed'];

export function milliseconds(value) {
  if (!value) return NaN;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Date.parse(value);
}

export function retentionState(record, now = new Date()) {
  if (!record || !DOWN_STATUSES.includes(record.status)) return { down: false, expired: false };
  const at = milliseconds(now);
  // A second takedown writes a new updatedAt even if the previous retention
  // stamp survives a quick restore. Bookkeeping removedAt never restarts it.
  const candidates = [record.takenDownAt, record.updatedAt].map(milliseconds)
    .filter(value => Number.isFinite(value) && value <= at);
  const start = candidates.length ? Math.max(...candidates) : milliseconds(record.removedAt);
  if (!Number.isFinite(start) || !Number.isFinite(at) || start > at) {
    return { down: true, expired: false, needsTimestamp: true };
  }
  return { down: true, expired: at - start >= RETENTION_MS,
    takenDownAt: new Date(start).toISOString(), expiresAt: new Date(start + RETENTION_MS).toISOString() };
}

/** Delete expired content transactionally, retaining non-content suppression
 * keys only. This is called by the scheduled publisher, never by a test
 * against production. A concurrent restore cancels deletion on the re-read. */
export async function retireJobs(db, { now = new Date(), publishedRows = [], dryRun = false } = {}) {
  const { removalSpecs, specMatches, buildOwned } = await import('./jobs-model.mjs');
  const collection = db.collection('jobSubmissions');
  const snapshot = await collection.where('status', 'in', DOWN_STATUSES).get();
  const counts = { deleted: 0, wouldDelete: 0, stamped: 0, held: 0 };
  for (const document of snapshot.docs) {
    const initial = retentionState(document.data(), now);
    if (!initial.expired && !initial.needsTimestamp) continue;
    if (dryRun) {
      const specs = removalSpecs([document]).specs;
      if (initial.expired && !publishedRows.some(row => specs.some(spec => specMatches(spec, row)))) counts.wouldDelete++;
      continue;
    }
    const outcome = await db.runTransaction(async transaction => {
      const fresh = await transaction.get(document.ref || collection.doc(document.id));
      if (!fresh.exists) return 'held';
      const value = fresh.data();
      const state = retentionState(value, now);
      if (!state.down) return 'held';
      if (state.needsTimestamp) {
        transaction.update(fresh.ref || collection.doc(document.id), { takenDownAt: now.toISOString() });
        return 'stamped';
      }
      if (!state.expired) return 'held';
      const specs = removalSpecs([{ id: document.id, data: () => value }]).specs;
      // Never delete the only editing handle while its posting is still served.
      if (!specs.length || publishedRows.some(row => specs.some(spec => specMatches(spec, row)))) return 'held';
      const sheetId = buildOwned(value) ? value.sheetId || '' : '';
      const reviewRef = sheetId && /^[A-Za-z0-9._~-]+$/.test(sheetId)
        ? db.collection('jobReviews').doc(sheetId) : null;
      const review = reviewRef ? await transaction.get(reviewRef) : null;
      transaction.set(db.collection('jobRemovalReceipts').doc(document.id), {
        version: 1, purgedAt: now.toISOString(), specs,
        sheetId,
      });
      // Retain only a retired source key so the crawler cannot queue the
      // original advertisement again. The review's content is removed too.
      if (review && (!review.exists || review.data().rowId === sheetId)) {
        transaction.set(reviewRef, { rowId: sheetId, status: 'retired', purgedAt: now.toISOString() });
      }
      transaction.delete(fresh.ref || collection.doc(document.id));
      return 'deleted';
    });
    counts[outcome]++;
  }
  return counts;
}
