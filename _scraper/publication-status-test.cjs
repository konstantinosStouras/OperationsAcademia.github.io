const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
const src=fs.readFileSync(path.join(root,'assets/oa-jobreview.js'),'utf8');
const start=src.indexOf('  function unpublishedApprovals('),end=src.indexOf('  var publicationRead',start);
const sandbox={URL,window:{},judgedRow:d=>{const r={...d.row,...d.edits};delete r.postedAtUrl;return r;},fieldValue:(d,k)=>(d.edits&&k in d.edits)?d.edits[k]:d.row[k]};
sandbox.OAAdvertDup=require(path.join(root,'assets/oa-advert-dup.js'));sandbox.window.OAAdvertDup=sandbox.OAAdvertDup;
vm.createContext(sandbox);vm.runInContext(src.slice(start,end),sandbox);
const check=sandbox.unpublishedApprovals,doc={status:'approved',rowId:'a',row:{id:'a',adUrl:'https://apply.interfolio.com/12345'}};
assert.equal(check([doc],[],[]).length,1,'approved but not deployed stays visible');
assert.equal(check([doc],[{id:'a'}],[]).length,0,'deployed ID leaves status list');
assert.equal(check([doc],[{id:'renamed',adUrl:'https://apply.interfolio.com/12345'}],[]).length,0,'alternate live ID recognized');
assert.equal(check([doc],[{id:'prior-season',postedAtUrl:'https://apply.interfolio.com/12345'}],[]).length,0,'application destination matches across fields and seasons');
assert.equal(check([doc],[],['a']).length,0,'explicit takedown excluded');
assert.equal(check([{...doc,status:'pending'}],[],[]).length,0,'pending not approved');
assert.equal(check([{...doc,edits:{adUrl:'https://apply.interfolio.com/67890'}}],[{id:'b',adUrl:'https://apply.interfolio.com/12345'}],[]).length,1,'saved edits drive matching');
assert(!src.slice(src.indexOf('  function approveAll('),src.indexOf('  /* ------------------------------------- the posting')).includes("if (act ==="),'bulk approval does not reference the single-card action');
assert.equal(check([{...doc,row:{id:'a',adUrl:'https://example.edu/advert',postedAtUrl:'https://hr.kimep.kz/en-US/Home/Vacancy/791'}}],[{id:'kimep-live',adUrl:'https://hr.kimep.kz/en-US/Home/Vacancy/791'}],[]).length,0,'verified official vacancy URL matches its live replacement');
new vm.Script(src);assert(src.includes("cache: 'no-store'"));assert(src.includes('Could not verify publication.'));assert(src.includes("if (act === 'approve') renderPublicationStatus(db)"));
const workflow=fs.readFileSync(path.join(root,'.github/workflows/oa-jobs-build.yml'),'utf8');
const build=workflow.indexOf('- name: Publish everything queued'),gate=workflow.indexOf('run: node _scraper/selftest.mjs --publishing'),commit=workflow.indexOf('- name: Commit');
assert(build<gate&&gate<commit,'full generated-data gate follows build and precedes commit');
assert(workflow.includes('if ! node _scraper/selftest.mjs --publishing; then'),'push retries retain validation');
console.log('Publication status regression checks passed');

// Cross-source equivalences are evidence-backed panel matches, not decisions
// to publish. The feed, identities, institution and both adverts must agree.
const verifiedPairs=[
 ['2027-essec-business-school-20260617','2027-essec-20260929','ESSEC','https://docs.google.com/forms/d/e/1FAIpQLScKGwFHes4KMhN5Kp1M6-pY1vmrwqJMKKE_u3T2E3TO2MIoEA/viewform','https://drive.google.com/file/d/1OrKYxVx_jfxG0MgnYRX4UKiqL9cMwgJL/view?usp=drivesdk'],
 ['2027-northern-state-university-20260913','2027-northern-state-university-20260717','Northern State University','https://www.higheredjobs.com/faculty/details.cfm?JobCode=179552277&Title=Assistant%20Professor','https://yourfuture.sdbor.edu/postings/48998']
];
for(const [oldId,liveId,institution,adUrl,target] of verifiedPairs){
 const approval={status:'approved',rowId:oldId,row:{id:oldId,institution,adUrl}};
 const replacement={id:liveId,institution,adUrl:target};
 const before=JSON.stringify([approval,replacement]);
 assert.equal(check([approval],[replacement],[]).length,0,'verified cross-source replacement is live');
 assert.equal(check([approval],[],[]).length,1,'replacement absent from feed stays unconfirmed');
 assert.equal(check([approval],[{...replacement,adUrl:'https://example.edu/different'}],[]).length,1,'changed live advert invalidates manual match');
 assert.equal(check([{...approval,edits:{adUrl:'https://example.edu/new'}}],[replacement],[]).length,1,'changed approved advert invalidates manual match');
 assert.equal(check([approval],[{...replacement,id:'different',adUrl:'https://example.edu/different'}],[]).length,1,'names alone do not establish a replacement');
 assert.equal(check([approval],[{...replacement,institution:'Different University'}],[]).length,1,'institution must agree');
 assert.equal(JSON.stringify([approval,replacement]),before,'panel matching never mutates records');
}
const uncertain=[
 ['2026-southern-methodist-university-cox-school-of-busi-20250829','Southern Methodist University'],
 ['2026-university-of-miami-herbert-20251002','University of Miami'],
 ['2027-hong-kong-university-of-science-and-technology-g-20260905','Hong Kong University of Science and Technology (Guangzhou)']
].map(([id,institution])=>({status:'approved',rowId:id,row:{id,institution}}));
assert.equal(check(uncertain,verifiedPairs.map(p=>({id:p[1],institution:p[2],adUrl:p[4]})),[]).length,3,'all three uncertain approvals stay visible');
console.log('Verified ESSEC/Northern State panel equivalences passed; three uncertain cases retained');
