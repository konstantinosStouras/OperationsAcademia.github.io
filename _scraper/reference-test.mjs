import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { referencePlaces } from './sync-reference-places.mjs';
const require = createRequire(import.meta.url);
const S = require('../assets/oa-schools.js');
const U = require('../assets/oa-uniinfo.js');
for (const variant of ['University at Buffalo - The State University of New York',
  'University at Buffalo, The State University of New York', 'State University of New York at Buffalo']) {
  assert.equal(S.canonInstitution(variant), 'University at Buffalo');
  assert.equal(S.directoryRowKey(variant, '', 'Operations Management'),
    S.directoryRowKey('University at Buffalo', '', 'Operations Management'));
}
assert.equal(S.institutionKey('Virginia Polytechnic Institute and State University'),
  S.institutionKey('Virginia Tech'), 'The full name must share the existing university identity');
assert.equal(S.directoryRowKey('Virginia Polytechnic Institute and State University', '', 'Data Science'),
  S.directoryRowKey('Virginia Tech', '', 'Data Science'), 'Existing correction addresses must remain stable');
for (const [institution, short, full, unit, id] of [
  ['Auburn University', 'Harbert College of Business', 'Raymond J. Harbert College of Business',
    'Supply Chain Management', 'auburn-university__harbert-college-of-business__supply-chain-management'],
  ['George Mason University', 'Costello College of Business', 'Donald G. Costello College of Business',
    'Information Systems and Operations Management', 'george-mason-university__costello-college-of-business__information-systems-and-operations-management'],
  ['Iowa State University', 'Ivy College of Business', 'Debbie and Jerry Ivy College of Business',
    'Supply Chain Management', 'iowa-state-university__ivy-college-of-business__supply-chain-management'],
]) {
  assert.equal(S.canonSchool(short, institution), full);
  assert.equal(S.directoryRowKey(institution, full, unit), id,
    'The official full name must preserve the existing correction address');
}
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
const empty = picker.fixedPlace({ institution: place.institution, school: '', unit: '' });
assert.equal(empty.school, '');
assert.equal(empty.unit, '');
context.window.OAUniInfo.record = async () => null;
assert.equal(await picker.vocabulary(), null,
  'An unavailable directory must not offer names from a different vocabulary');
const exported = referencePlaces([{ row: { institution: 'NUS', school: 'NUS Business School',
  unit: 'Analytics and Operations', name: 'Private person', email: 'private@example.com', id: 'private' } }]);
assert.equal(exported.length, 1);
assert.deepEqual(Object.keys(exported[0]).sort(), ['department', 'institution', 'school']);
assert.equal(exported[0].institution, 'National University of Singapore');
assert.ok(!JSON.stringify(exported).includes('private'));
const legacy = referencePlaces([
  { affiliation: 'Rotman School of Management, University of Toronto', name: 'Private candidate' },
  { affiliation: 'University of Nantes', email: 'private@example.com' },
  { affiliation: 'PhD, University of Toronto; visiting Stanford University' },
  { affiliation: 'Private Analytics Company' },
], { universities: ['University of Toronto', 'Stanford University'],
  schools: [['Rotman School of Management', 'University of Toronto']] });
assert.equal(legacy.length, 2);
assert.equal(legacy.find(p => p.institution === 'University of Toronto').school, 'Joseph L. Rotman School of Management');
assert.ok(legacy.some(p => p.institution === 'University of Nantes'));
assert.ok(!JSON.stringify(legacy).includes('Private'));
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
D.state.flat = [
  { id: 'essec-old', institution: 'ESSEC', school: 'ESSEC Business School', department: 'Operations Management', n: 1 },
  { id: 'essec-new', institution: 'ESSEC', school: 'ESSEC Business School', department: 'Information Systems, Data Analytics and Operations', n: 1 },
];
D.state.edits = Object.fromEntries(D.state.flat.map((r, i) => [r.id, {
  institution: 'The ESSEC Business School',
  department: 'Department of Information Systems, Data Analytics and Operations', t: i + 1,
}]));
D.regroup();
assert.equal(D.state.cards.length, 1, 'A full university title retains its canonical identity');
assert.equal(D.state.cards[0].institution, 'ESSEC Business School',
  'Keep the explicit full university title while dropping its leading The');
assert.equal(D.state.cards[0].n, 2, 'Renaming the title retains both postings');
D.state.flat = [
  { id: 'vt-existing', institution: 'Virginia Tech', school: 'College of Science', department: 'Data Science', n: 1 },
  { id: 'vt-new-posting', institution: 'Virginia Tech', school: 'College of Engineering', department: 'Operations Research', n: 1 },
];
D.state.edits = { 'vt-existing': {
  institution: 'Virginia Polytechnic Institute and State University', department: 'Academy of Data Science', t: 1,
} };
D.regroup();
assert.equal(D.state.cards.length, 1, 'A later short-name posting joins the corrected university card');
assert.equal(D.state.cards[0].n, 2, 'Both university spellings retain their posting references');
console.log('Directory tests passed: individual school assignment and retention of official department titles.');
