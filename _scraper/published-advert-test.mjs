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
// Distinct INSEAD vacancies share a page, department, rank and application email.
const human = { ...live, id: 'human', institution: 'INSEAD', department: 'Technology and Operations Management', levels: ['Post-Doc'], adUrl: 'https://www.insead.edu/faculty-research/academic-areas/technology-operations-management#549386' };
const health = { ...human, id: 'health', adUrl: human.adUrl.replace('549386','684501') };
assert.equal(advertRepeat(health, [human]), null);
assert.equal(publishedAdvertRepeat(health, [human]), null);
assert.equal(advertRepeat({ ...human, id: 'repeat', adUrl: human.adUrl.replace('#', '?utm_source=sheet#') }, [human])?.id, 'human');
assert.equal(publishedAdvertRepeat({ ...human, id: 'repeat' }, [human])?.id, 'human');
// A shared careers PORTAL is not one vacancy across universities (2026-10-28):
// Georgia Gwinnett College and Valdosta State both link the University System
// of Georgia's PeopleSoft search page, and Gwinnett's posting was rejected at
// ingest as "the same vacancy" as Valdosta's 2025 one. A bare link matches only
// within one university; a link carrying a vacancy id still matches anywhere.
const usg = 'https://careers.hprod.onehcm.usg.edu/psc/careers/CAREERS/HRMS/c/HRS_HRAM_FL.HRS_CG_SEARCH_FL.GBL?Page=HRS_APP_SCHJOB_FL&Action=U';
const valdosta = { id: '2026-valdosta-state-university-20251116', institution: 'Valdosta State University',
  year: 2026, department: 'BA', levels: [], adUrl: usg };
const gwinnett = { id: 'gwinnett', institution: 'Georgia Gwinnett College', year: 2027,
  department: 'Supply Chain Management', levels: ['Assistant Professor'], adUrl: usg };
assert.equal(publishedAdvertRepeat(gwinnett, [valdosta]), null,
  'a careers portal shared by two universities is not one vacancy');
assert.equal(publishedAdvertRepeat({ ...gwinnett, institution: 'The Valdosta State University' }, [valdosta])?.id,
  valdosta.id, 'the same portal at the same university still is');
assert.equal(publishedAdvertRepeat({ ...gwinnett, adUrl: 'https://apply.interfolio.com/195349' },
  [{ ...valdosta, adUrl: 'https://apply.interfolio.com/195349' }])?.id, valdosta.id,
  'and a vacancy id names one job whatever the institution says');
console.log('Shared-portal admission checks passed.');
