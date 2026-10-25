import assert from 'node:assert/strict';
import { publishedAdvertRepeat, advertRepeat } from './jobreview.mjs';

const live = { id: 'live', institution: 'Ohio State University', year: 2027,
  department: 'College of Engineering, Integrated Systems Engineering',
  levels: ['Assistant Professor'], adUrl: 'https://apply.interfolio.com/195349' };
const crawled = { ...live, id: 'crawled', department: 'Optimization for Machine Learning' };
assert.equal(publishedAdvertRepeat(crawled, [live])?.id, 'live');
assert.equal(publishedAdvertRepeat({ ...crawled, institution: 'Different spelling', year: 2026,
  levels: ['Post-Doc'] }, [live])?.id, 'live');
assert.equal(publishedAdvertRepeat({ ...crawled,
  adUrl: 'https://apply.interfolio.com/195349/?utm_source=sheet#apply' }, [live])?.id, 'live');
assert.equal(publishedAdvertRepeat({ ...crawled, adUrl: 'https://apply.interfolio.com/195350' }, [live]), null);
assert.equal(publishedAdvertRepeat(crawled, []), null);
assert.equal(publishedAdvertRepeat(live, [live]), null);
for (const adUrl of ['', 'https://www.operationsacademia.org/']) {
  assert.equal(publishedAdvertRepeat({ ...crawled, adUrl }, [{ ...live, adUrl }]), null);
}
const generic = { ...live, adUrl: 'https://university.edu/jobs' };
const otherDepartment = { ...crawled, adUrl: generic.adUrl };
assert.equal(publishedAdvertRepeat(otherDepartment, [generic])?.id, 'live');
assert.equal(advertRepeat(otherDepartment, [generic]), null, 'pending comparisons keep existing guards');
console.log('Published advert admission checks passed.');

// Either field can contain the vacancy URL on either side of the comparison.
for (const candidateField of ['adUrl', 'postedAtUrl']) {
  for (const publishedField of ['adUrl', 'postedAtUrl']) {
    const candidate = { ...crawled, adUrl: '', postedAtUrl: '',
      [candidateField]: 'https://apply.interfolio.com/195349/?utm_source=sheet#apply' };
    const published = { ...live, adUrl: 'https://drive.google.com/file/d/example/view',
      postedAtUrl: '', [publishedField]: 'https://apply.interfolio.com/195349' };
    assert.equal(publishedAdvertRepeat(candidate, [published])?.id, 'live');
    assert.equal(publishedAdvertRepeat({ ...candidate,
      [candidateField]: 'https://apply.interfolio.com/195350' }, [published]), null);
  }
}
assert.equal(publishedAdvertRepeat(null, [live]), null);
assert.equal(publishedAdvertRepeat({ id: 'empty', postedAtUrl: '' }, [live]), null);
assert.equal(publishedAdvertRepeat({ id: 'home', postedAtUrl: 'https://operationsacademia.org/' },
  [{ ...live, postedAtUrl: 'https://operationsacademia.org/' }]), null);
console.log('Advert and Posted at cross-field admission checks passed.');
const board = 'https://www.poms.org/opportunities';
assert.equal(publishedAdvertRepeat({ ...crawled, adUrl: 'https://example.edu/job-a.pdf', postedAtUrl: board },
  [{ ...live, adUrl: 'https://example.edu/job-b.pdf', postedAtUrl: board }]), null,
  'a shared Posted at source board must not suppress unrelated jobs');
assert.equal(publishedAdvertRepeat({ ...crawled, adUrl: 'https://example.edu/job-a.pdf', postedAtUrl: board },
  [{ ...live, adUrl: 'https://example.edu/job-a.pdf', postedAtUrl: board }])?.id, 'live',
  'identical advert links still match when Posted at is a source board');
console.log('Shared source-board regression checks passed.');