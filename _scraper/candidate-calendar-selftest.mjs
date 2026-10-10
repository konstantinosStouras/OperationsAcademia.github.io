import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rowFromCandidateSubmission, publicCandidateRow } from './candidates-model.mjs';
const require = createRequire(import.meta.url);
const Cal = require('../assets/oa-candidate-calendar.js');
const Card = require('../assets/oa-candcard.js');
const Schools = require('../assets/oa-schools.js');
const row = { id: 'demo-candidate', year: 2027, name: 'Example Candidate', position: 'PhD Candidate',
  affiliation: 'Operations, Example University', informsDays: ['Tuesday'],
  informsUrl: 'https://submissions.mirasmart.com/InformsAnnual2026/Itinerary/PresentationDetail.aspx?evdid=374',
  cvUrl: 'https://example.edu/cv.pdf', webUrl: 'https://example.edu/', researchAreas: ['Operations'],
  email: 'public@example.edu', personalEmail: 'private@example.com',
  jobTalk: { date: '2026-11-03', at: '13:30', end: '13:48', location: 'Moscone South-312 (Level 3)', title: 'Example job market talk' } };
assert.equal(Cal.event(row).minutes, 18);
const google = new URL(Cal.googleUrl(row));
assert.equal(google.searchParams.get('dates'), '20261103T213000Z/20261103T214800Z');
assert.equal(google.searchParams.get('ctz'), 'America/Los_Angeles');
assert.match(google.searchParams.get('details'), /PresentationDetail.aspx\?evdid=374/);
assert.match(google.searchParams.get('details'), /CV: https:\/\/example.edu\/cv.pdf/);
assert.match(google.searchParams.get('details'), /Candidate profile:/);
assert.doesNotMatch(google.searchParams.get('details'), /private@example|public@example/);
assert.equal(Cal.utcStamp('2026-07-01', '13:30', 'America/Los_Angeles'), '20260701T203000Z');
const ics = Cal.calendar(row, new Date('2026-10-09T12:00:00Z')).replace(/\r\n /g, '');
assert.match(ics, /DTSTART;TZID=America\/Los_Angeles:20261103T133000/);
assert.match(ics, /DTEND;TZID=America\/Los_Angeles:20261103T134800/);
assert.match(ics, /BEGIN:VTIMEZONE/);
assert.doesNotMatch(ics, /private@example|public@example/);
assert.equal(Cal.links({ ...row, jobTalk: {} }), null);
assert.equal(Cal.links({ ...row, informsDays: [] }), null);
assert.equal(Cal.links({ ...row, informsUrl: 'https://example.edu/' }), null);
assert.equal(Cal.links({ ...row, jobTalk: { ...row.jobTalk, end: '13:00' } }), null);
assert.equal(Cal.links({ ...row, jobTalk: { ...row.jobTalk, date: '2026-11-02' } }), null);
const links = Cal.links(row);
assert.match(links, />Google<\/a>/);
assert.match(links, /download="informs-job-talk-demo-candidate.ics"/);
assert.match(links, />Outlook\/Apple<\/a>/);
const doc = { ...row, first: 'Example', last: 'Candidate', institution: 'Example University', school: '', unit: 'Operations',
  createdAt: '2026-10-09T12:00:00Z', jobTalk: { ...row.jobTalk, secret: 'private' } };
const build = rowFromCandidateSubmission(doc);
const browser = Card.publicRowFromDoc(doc, { canonColumns: Schools.canonColumns, ownerTag: () => '' });
assert.deepEqual(build.jobTalk, browser.jobTalk);
assert.equal(publicCandidateRow(build).jobTalk.secret, undefined);
assert.equal(Cal.event(browser).minutes, 18);
const rows = Card.cardConfig({ calendar: Cal, link: (url) => url || null, mailto: () => null }).rows(row);
assert.equal(rows.filter(r => r.label === 'INFORMS job talk').length, 0);
assert.ok(rows.some(r => r.label === 'Presenting at INFORMS'));
assert.ok(rows.some(r => r.label === 'INFORMS talk(s)' && r.html.includes(row.informsUrl) && r.html.includes('Add to calendar:') && r.html.includes('>Google</a>') && r.html.includes('>Outlook/Apple</a>')));
console.log('candidate-calendar: checks passed');
