import assert from 'node:assert/strict';
import {rowFromSubmission,submissionFromRow} from './jobs-model.mjs';
import {EDITABLE} from './jobreview.mjs';
const limit=EDITABLE.find(f=>f.key==='comments').max;
const comments='x'.repeat(limit);
const row={year:2027,posted:'2026-08-21',institution:'University College London',school:'UCL School of Management',unit:'Operations and Technology',department:'UCL School of Management, Operations and Technology',country:'United Kingdom',type:'Business School',levels:['Assistant Professor'],comments,addedAt:'2026-08-21T12:00:00Z',applyByDate:'2026-11-30',applyBy:'November 30, 2026'};
assert.equal(rowFromSubmission(submissionFromRow(row)).comments,comments,'Publishing must preserve all Comments accepted by review');
assert.equal(rowFromSubmission({...submissionFromRow(row),comments:comments+'x'}).comments.length,limit,'The published cap remains bounded');
console.log('Reviewed Comments publication regression passed');
