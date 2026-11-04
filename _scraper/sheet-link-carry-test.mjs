import assert from 'node:assert/strict';
import { carrySheetLinks } from './sheet-link-carry.mjs';
import { approvedRow } from './jobreview.mjs';
import { rowsFromTab } from './jobmarket-sheet.mjs';
const prior = { id: 'stanford', adUrl: 'https://msande.stanford.edu/faculty-openings',
  postedAtUrl: 'https://facultypositions.stanford.edu/jobs/example' };
const blank = { ...prior, adUrl: '', postedAtUrl: '' };
const kept = carrySheetLinks([blank], [prior]);
assert.equal(kept.rows[0].adUrl, prior.adUrl);
assert.equal(kept.rows[0].postedAtUrl, prior.postedAtUrl);
assert.equal(blank.adUrl, '', 'inputs are untouched');
assert.equal(carrySheetLinks(kept.rows, [prior]).carried.length, 0);
assert.equal(carrySheetLinks([{ ...blank, adUrl: 'https://new.stanford.edu/ad' }], [prior]).rows[0].adUrl,
  'https://new.stanford.edu/ad');
assert.equal(carrySheetLinks([{ ...blank, id: 'another' }], [prior]).rows[0].adUrl, '');
assert.equal(carrySheetLinks([blank], [{ ...prior, adUrl: 'javascript:bad' }]).rows[0].adUrl, '');
assert.equal(approvedRow(kept.rows[0], { edits: { adUrl: '', postedAtUrl: '' } }).adUrl, '',
  'an explicit maintainer removal still wins after the carry');
assert.equal(approvedRow(kept.rows[0], { edits: { postedAtUrl: '' } }).postedAtUrl, '');
// The actual source change: Sheets CSV exports a rich hyperlink's label,
// not its address. A recognised link column can still contain no usable URL.
const parsed = rowsFromTab('University,Date Posted,Area,Link\nStanford MS&E,2026-08-21,Management Science and Engineering,Faculty Openings | Management Science and Engineering',
  { tab: '2026 Jobs', kind: 'jobs', cycleYear: 2027 });
assert.equal(parsed.rows.length, 1);
assert.equal(parsed.rows[0].adUrl, '');
assert.equal(carrySheetLinks(parsed.rows, [{ ...prior, id: parsed.rows[0].id }]).rows[0].adUrl, prior.adUrl);
console.log('Sheet advertisement carry regression checks passed');
