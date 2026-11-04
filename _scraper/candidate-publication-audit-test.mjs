import assert from 'node:assert/strict';
import { auditCandidatePublication } from './audit-candidate-publication.mjs';
import { rowFromCandidateSubmission } from './candidates-model.mjs';
const now = new Date('2026-11-04T12:00:00Z');
const doc = { first: 'Example', last: 'Candidate', affiliation: 'Example University',
  position: 'PhD Candidate', year: 2027, status: 'queued', ref: 'audit-reference' };
const row = rowFromCandidateSubmission(doc, { now });
assert.equal(auditCandidatePublication([doc], [], {}, now).missing, 1);
assert.equal(auditCandidatePublication([doc], [row], {}, now).represented, 1);
assert.equal(auditCandidatePublication([doc, { ...doc, status: 'published' }], [row], {}, now).missing, 0);
assert.equal(auditCandidatePublication([{ ...doc, status: 'withdrawn' }], [], {}, now).missing, 0);
assert.equal(auditCandidatePublication([doc], [], { refs: [doc.ref] }, now).suppressed, 1);
assert.equal(auditCandidatePublication([{ ...doc, first: '' }], [], {}, now).invalid, 1);
assert.equal(auditCandidatePublication([{ ...doc, status: 'unknown' }], [], {}, now).unexpectedStatus, 1);
assert.equal(auditCandidatePublication([{ ...doc, year: 2026, createdAt: '2025-10-01T12:00:00Z' }], [], {}, now).previousMarket, 1);
assert.equal(auditCandidatePublication([{ ...doc, uid: 'different-owner' }], [row], {}, now).missing, 1);
assert.ok(!JSON.stringify(auditCandidatePublication([doc], [], {}, now)).includes(doc.first));
console.log('Candidate publication audit regression checks passed');
