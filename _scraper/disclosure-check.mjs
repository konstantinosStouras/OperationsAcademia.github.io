import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// candidates-model publishes this one field only with emailPublic === true.
// The candidate model tests verify that consent gate; this check enforces
// that no other field or served dataset can contain an email address.
export function hasPrivateAddress(relative, text) {
  if (relative === 'candidates.json') {
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) throw new Error('candidates.json must be an array');
    text = JSON.stringify(rows.map(row => {
      const copy = { ...row };
      if (typeof copy.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(copy.email)) delete copy.email;
      return copy;
    }));
  }
  return EMAIL.test(text);
}

function selftest() {
  assert.equal(hasPrivateAddress('candidates.json', '[{"email":"public@example.org"}]'), false);
  for (const row of [
    { authEmail: 'private@example.org' },
    { email: 'public@example.org', note: 'private@example.org' },
    { nested: { email: 'private@example.org' } },
    { email: { value: 'private@example.org' } },
    { email: 'Contact private@example.org for details' },
  ]) assert.equal(hasPrivateAddress('candidates.json', JSON.stringify([row])), true);
  assert.equal(hasPrivateAddress('jobs.json', '[{"email":"private@example.org"}]'), true);
  assert.equal(hasPrivateAddress('archive/candidates.json', '[{"email":"private@example.org"}]'), true);
  assert.equal(hasPrivateAddress('notes.txt', 'private@example.org'), true);
  assert.equal(hasPrivateAddress('notes.txt', 'No contact details.'), false);
  assert.throws(() => hasPrivateAddress('candidates.json', '{}'));
}

async function main() {
  selftest();
  const root = fileURLToPath(new URL('../data/', import.meta.url));
  const failures = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        const relative = path.relative(root, file).split(path.sep).join('/');
        if (hasPrivateAddress(relative, await readFile(file, 'utf8'))) failures.push(relative);
      }
    }
  }
  await visit(root);
  // Report paths only: the guard must never print the addresses it finds.
  if (failures.length) throw new Error('Email address outside the opted-in candidate contact field: ' + failures.join(', '));
  console.log('Disclosure check passed: only opted-in candidate contact fields may contain email addresses.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
