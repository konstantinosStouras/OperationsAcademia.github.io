import assert from 'node:assert/strict';
import { carrySheetLinks } from './sheet-link-carry.mjs';
import { approvedRow } from './jobreview.mjs';
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
console.log('Sheet advertisement carry regression checks passed');
