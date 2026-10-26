import fs from 'node:fs';
import assert from 'node:assert/strict';
const base=new URL('../data/faculty-link-review/',import.meta.url);
const read=name=>JSON.parse(fs.readFileSync(new URL(name,base),'utf8'));
const manifest=read('manifest.json');
const reviews=[0,1,2,3].flatMap(i=>read(`results-${i}.json`).records);
const byId=new Map(reviews.map(r=>[r.id,r]));
assert.equal(byId.size,reviews.length,'Each original identity must have one review');
const identity=r=>JSON.stringify([r.institution,r.school,r.department]);
const totals={verified:0,'needs-review':0,'no-public-list':0,excluded:0,unchecked:0};
const mapEntries={...totals};
for(const original of manifest.records){
  const review=byId.get(original.id),status=review?.status||'unchecked';
  assert.ok(Object.hasOwn(totals,status),'Unknown review status');
  if(review)assert.equal(identity(review),identity(original),original.id+' identity changed');
  if(status==='verified')assert.ok(/^https:\/\//.test(review.facultyUrl)&&review.sources?.length&&review.evidence&&review.checked,original.id+' lacks verification');
  totals[status]++;mapEntries[status]+=original.pointIds.length;
}
assert.equal(Object.values(mapEntries).reduce((a,b)=>a+b,0),manifest.initialMissingRows);
const summary={checked:'2026-10-26',originalMapEntries:manifest.initialMissingRows,distinctDepartmentIdentities:manifest.records.length,departments:totals,mapEntries};
fs.writeFileSync(new URL('summary.json',base),JSON.stringify(summary,null,2)+'\n');
const clean=s=>String(s||'').replaceAll('|','\\|').replace(/\s+/g,' ').trim();
const lines=[
  '# Faculty-list verification',
  '',
  'Reviewed against official institutional sources on 26 October 2026. The original 665 missing map entries represent 638 distinct department identities; a department can appear at multiple locations.',
  '',
  '| Outcome | Distinct departments | Original map entries |',
  '| --- | ---: | ---: |',
  ...Object.keys(totals).map(status=>`| ${status} | ${totals[status]} | ${mapEntries[status]} |`),
  '',
  'A verified link has named faculty on an official roster. Where the university requires an interactive filter, the card shows instructions. Confirmed hiring specializations without a separate department can use their documented parent academic unit; scope notes distinguish these from exact department rosters. Partial sample lists, personal profiles and inaccessible candidate URLs are not treated as complete verified directories.',
  '',
  'The two excluded records are the inaccessible Columbia University and Korea Advanced Institute of Science and Technology advertisements the site owner explicitly asked to ignore. A no-public-list outcome means no suitable list was found in the inspected sources, not proof that none exists.',
  '',
  'The original identifiers in manifest.json and results-0.json through results-3.json are stable. current-missing.json is a fresh rendered-map audit: its numbered identifiers are local to that snapshot and must not be joined to the original manifest by number. sources, evidence and notes in each original result retain the verification trail. Supplementary recheck files preserve later investigations; the four results files are authoritative.',
  '',
  '## Entries without a verified faculty-list URL',
  '',
  '| Institution and unit | Outcome | Reason | Sources checked |',
  '| --- | --- | --- | --- |'
];
for(const original of manifest.records){
  const r=byId.get(original.id);if(r?.status==='verified')continue;
  const links=(r?.sources||[]).map((url,i)=>`[Source ${i+1}](${url})`).join(' · ');
  lines.push(`| ${clean(original.institution)} — ${clean(original.school)} — ${clean(original.department)} | ${r?.status||'unchecked'} | ${clean(r?.notes||r?.evidence||'Review not completed.')} | ${links} |`);
}
fs.writeFileSync(new URL('README.md',base),lines.join('\n')+'\n');
console.log(JSON.stringify(summary));
