import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pomsEvidence, confirmedPomsRepeat, VERIFIED_MIRRORS, HUNTSVILLE_AD } from './poms-evidence.mjs';
import { rowFromOpportunity, nearbyPostings } from './poms.mjs';
import { duplicatesOf, queueDoc } from './jobreview.mjs';
const live={id:'existing',year:2027,institution:'Example University',unit:'Operations',department:'Operations',posted:'2026-10-05',levels:['Assistant Professor'],adUrl:'https://apply.interfolio.com/111'};
const other={...live,id:'new',posted:'2026-10-06',adUrl:'https://apply.interfolio.com/222'};
assert(duplicatesOf(other,[live]).length && nearbyPostings(other,[live]).length);
assert.equal(confirmedPomsRepeat(other,[live]),null,'same university, department, rank and week cannot discard a distinct vacancy');
assert.equal(queueDoc(other,{dup:duplicatesOf(other,[live])}).status,'pending');
assert.equal(confirmedPomsRepeat({...other,adUrl:live.adUrl},[live])?.id,'existing');
assert.equal(confirmedPomsRepeat({...other,adUrl:'https://poms.org/a.pdf'},[live],[live.adUrl])?.id,'existing');
assert.equal(confirmedPomsRepeat({...other,postedAtUrl:'https://www.poms.org/opportunities'},[{...live,postedAtUrl:'https://www.poms.org/opportunities'}]),null);
// Every audited mirror is content-gated, not an unconditional URL exception.
for(const m of VERIFIED_MIRRORS) {
 const opp={href:m.source};
 assert.deepEqual(pomsEvidence(opp,{text:m.markers.join('\n')}).confirmedUrls,[m.url]);
 assert.deepEqual(pomsEvidence(opp,{text:'different advert'}).confirmedUrls,[]);
 assert.deepEqual(pomsEvidence({href:m.source+'-changed'},{text:m.markers.join(' ')}).confirmedUrls,[]);
}
const index={href:HUNTSVILLE_AD,institution:'University of Alabama',title:'Eminent Scholar and Professor',date:'2026-10-23',kind:'pdf'};
const corrected=pomsEvidence(index,{text:'The University of Alabama in Huntsville seeks an Eminent Scholar. Log 26-27-141.',parsed:{}});
const row=rowFromOpportunity(corrected.opp,{ad:corrected.parsed,now:new Date('2026-10-25T12:00:00Z')});
assert.equal(row.institution,'University of Alabama in Huntsville');
assert.equal(row.school,'College of Business');
assert.equal(row.unit,'Information Systems, Supply Chain, and Analytics');
assert.deepEqual(row.levels,['Other Ranks']);
assert.equal(row.country,'United States');
assert.equal(row.reviewDate,'2026-12-01');
assert.equal(row.applyByDate,'');
assert.match(row.comments,/26-27-141/);
assert.equal(confirmedPomsRepeat(row,[{...live,institution:'University of Alabama'}]),null);
assert.equal(pomsEvidence(index,{text:'Unrelated PDF',parsed:{}}).opp.institution,'University of Alabama');
const src=readFileSync(new URL('./poms-crawl.mjs',import.meta.url),'utf8');
assert(src.includes('confirmedPomsRepeat(row, duplicateRows, confirmedUrls)'));
assert(src.includes('confirmedPomsRepeat(row, currentRows, confirmedUrls)'));
assert(!src.includes('|| duplicatesOf(row, currentRows).length') && !src.includes('possible duplicate, not queued:'));

const psuUrl='https://psu.wd1.myworkdayjobs.com/PSU_Academic/job/Penn-State-University-Park/Open-Rank-Professor-in-Supply-Chain-Management_REQ_0000082573-1';
const psu={...live,adUrl:'https://drive.google.com/file/d/example/view',postedAtUrl:psuUrl};
assert.equal(confirmedPomsRepeat({...other,adUrl:psuUrl},[psu])?.id,'existing');
assert.equal(confirmedPomsRepeat({...other,adUrl:psuUrl.replace('82573','82547')},[psu]),null,'different Workday REQ IDs stay distinct');

console.log('POMS admission regressions passed: uncertain jobs queue; confirmed mirrors skip; Huntsville details restored.');
