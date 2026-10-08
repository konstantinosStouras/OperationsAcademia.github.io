import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { referencePlaces } from './sync-reference-places.mjs';
const require = createRequire(import.meta.url);
const S = require('../assets/oa-schools.js');
const U = require('../assets/oa-uniinfo.js');
const place = { institution: 'Purdue University', school: 'Mitch Daniels School of Business',
  department: 'Supply Chain and Operations Management Department', id: 'verified' };
const hidden = { institution: 'Hidden University', school: '', department: '', _hidden: true };
const context = { window: { OASchools: S, OAUniInfo: { ...U, record: async () => [place, hidden] } } };
vm.createContext(context);
vm.runInContext(await readFile(new URL('../assets/oa-place-picker.js', import.meta.url), 'utf8'), context);
const picker = context.window.OAPlacePicker;
const vocabulary = await picker.vocabulary();
assert.deepEqual(Array.from(vocabulary.universities, o => o.v), ['Purdue University']);
assert.deepEqual(Array.from(vocabulary.byUniversity['Purdue University'].schools), [place.school]);
assert.deepEqual(Array.from(vocabulary.byUniversity['Purdue University'].units), [place.department]);
const settled = picker.fixedPlace({ institution: place.institution, school: place.school,
  unit: 'Supply Chain and Operations Management Faculty' });
assert.equal(settled.unit, place.department);
assert.equal(settled.school, place.school);
const exported = referencePlaces([{ row: { institution: 'NUS', school: 'NUS Business School',
  unit: 'Analytics and Operations', name: 'Private person', email: 'private@example.com', id: 'private' } }]);
assert.equal(exported.length, 1);
assert.deepEqual(Object.keys(exported[0]).sort(), ['department', 'institution', 'school']);
assert.equal(exported[0].institution, 'National University of Singapore');
assert.ok(!JSON.stringify(exported).includes('private'));
console.log('Reference tests passed: shared names, official department titles, hidden rows and names-only export.');
const directoryContext = { window: { OASchools: S }, OASchools: S };
vm.createContext(directoryContext);
let directorySource = await readFile(new URL('../assets/oa-directory.js', import.meta.url), 'utf8');
directorySource = directorySource.replace('  window.OADirectory = {',
  '  window.testDirectory = { state: state, regroup: regroup, planSchool: planSchool, formHTML: formHTML }; window.OADirectory = {');
vm.runInContext(directorySource, directoryContext);
const D = directoryContext.window.testDirectory;
const rows = [
  { id: 'supply', institution: 'Michigan State University', school: '', department: 'Supply Chain Management', type: 'University' },
  { id: 'stats', institution: 'Michigan State University', school: '', department: 'Statistics and Probability', type: 'University' },
];
D.state.flat = rows;
const shown = {};
for (const key of ['institution', 'school', 'country', 'type']) shown['s.' + key] = rows[0][key] || '';
rows.forEach((r, i) => ['school', 'type', 'department', 'deptUrl', 'facultyUrl'].forEach(key => {
  shown['r' + i + '.' + key] = r[key] || '';
}));
const spec = { kind: 'school', rows: rows.map(r => ({ id: r.id })), shown, values: { ...shown },
  mixed: {}, campuses: [], seq: 1, title: '', institution: rows[0].institution };
spec.values['r0.school'] = 'Eli Broad College of Business';
spec.values['r0.type'] = 'Business School';
const plan = D.planSchool(spec);
assert.ok(!plan.error);
assert.equal(plan.entries.length, 1);
assert.equal(plan.entries[0].rowId, 'supply');
assert.equal(plan.entries[0].patch.school, 'Eli Broad College of Business');
assert.equal(plan.entries[0].patch.type, 'Business School');
assert.ok(D.formHTML(spec).includes('School for this department'));
const unchanged = { ...spec, values: { ...shown }, checked: true };
assert.equal(D.planSchool(unchanged).entries.length, 2);
assert.ok(D.planSchool(unchanged).entries.every(e => Object.keys(e.patch).length === 0));
D.state.edits = { supply: { department: 'Department of Supply Chain Management', t: 1 } };
D.regroup();
assert.ok(D.state.cards.some(c => c.schools.some(s => s.rows.some(r => r.department === 'Department of Supply Chain Management'))));
console.log('Directory tests passed: individual school assignment and retention of official department titles.');
