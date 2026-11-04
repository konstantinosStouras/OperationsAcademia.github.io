import { url } from './jobs-model.mjs';

// A blank/unparseable CSV cell is not evidence that a working advertisement
// should disappear. Real replacement URLs still win. Explicit review edits
// (including clearing a link) are applied AFTER this pass by approvedRow().
export function carrySheetLinks(rows, known = []) {
  const previous = new Map();
  for (const row of known) if (row?.id && !previous.has(row.id)) previous.set(row.id, row);
  const carried = [];
  const result = rows.map(row => {
    const prior = previous.get(row.id);
    if (!prior) return row;
    const patch = {};
    for (const field of ['adUrl', 'postedAtUrl']) {
      if (!url(row[field]) && url(prior[field])) patch[field] = url(prior[field]);
    }
    if (!Object.keys(patch).length) return row;
    carried.push({ id: row.id, fields: Object.keys(patch) });
    return { ...row, ...patch };
  });
  return { rows: result, carried };
}
