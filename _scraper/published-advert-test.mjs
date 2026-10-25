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
