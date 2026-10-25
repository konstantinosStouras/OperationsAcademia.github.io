import { publishedAdvertRepeat, advertRepeat } from './jobreview.mjs';
// Verified POMS mirror evidence, audited 2026-10-25 against the PDF contents.
// Exact source URLs AND content markers are required; titles/university/dates
// alone never identify a vacancy. These facts do not approve a posting.
export const HUNTSVILLE_AD = 'https://www.poms.org/sites/default/files/2026-10/9910745.pdf';
const base='https://www.poms.org/sites/default/files/2026-10/';
const msu='https://careers.msu.edu/jobs/assistant-professor-tenure-system-east-lansing-michigan-united-states-';
const psu='https://psu.wd1.myworkdayjobs.com/PSU_Academic/job/Penn-State-University-Park/';
const unt='https://careers.untsystem.edu/jobs/assistant-professor-of-supply-chain-management-denton-texas-united-states';
// Each exact application URL below is printed in its PDF. Nebraska prints the
// requisition rather than the full URL; the employer page confirms F_260124.
// RIT was verified by its detailed description, start date and teaching load.
export const VERIFIED_MIRRORS = [
 ['F_260124 Approved Ad 10-16-26.pdf','https://employment.unl.edu/postings/102824',['F_260124','Assistant Professor of Practice','August 2027']],
 ['Assistant Professor SCM Posting_FINAL.pdf','https://jobs.auburn.edu/auburn-careers-home/jobs/10498?lang=en-us'],
 ['UNT SCM Assistant Prof Announcement_0.pdf',unt,[unt.replace('united-states',''),'Posting united-states','Fall 2027']],
 ['UNT SCM Assistant Prof Announcement.pdf',unt,[unt.replace('united-states',''),'Posting united-states','Fall 2027']],
 ['OCR Approved Ad_Engineering One Health cluster search_External.pdf','https://careers.purdue.edu/job/AssistantAssociate-Professor-in-One-Health-Intelligent-Medicines-College-of-Engineering/44246-en_US/'],
 ['9879642.pdf','https://rit.wd12.myworkdayjobs.com/en-US/careers/job/Assistant-Professor--Tenure-Track---Supply-Chain--Proj---Oper-Mgt-Quant-Meth_JR103197',[
 'The Management Department in the Saunders College of Business at Rochester Institute of Technology invites applications for a full-time, tenure-track assistant professor of supply chain management starting August 11, 2027.',
 'Teaching load is 2/2 for pre-tenure faculty','https://apptrkr.com/9879642']],
 ['Job Posting - Assistant Professor-Tenure System #1171110.pdf',msu+'c6150b92-6653-41dd-92f9-96b250f60f20'],
 ['Job Posting - Assistant Professor-Tenure System #1171109.pdf',msu+'0d7a7af8-54ff-4f5a-801f-906d576fff7a'],
 ['9861245.pdf',psu+'Open-Rank-Professor-in-Supply-Chain-Management_REQ_0000082573-1'],
 ['9861301.pdf',psu+'Open-Rank-Professor-in-Business-Analytics-and-Information-Systems_REQ_0000082577-1'],
 ['9861339.pdf',psu+'Assistant-Professor-in-Supply-Chain-Management_REQ_0000082547-1'],
].map(([file,url,markers])=>({source:base+encodeURIComponent(file),url,markers:markers||[url]}));
const compact=s=>String(s||'').replace(/\s+/g,'').toLowerCase();
function sameUrl(a,b) { try { return decodeURI(new URL(a).href)===decodeURI(new URL(b).href); } catch { return false; } }
export function pomsEvidence(opp, read) {
 const body=compact(read.text);
 const mirror=VERIFIED_MIRRORS.find(m=>sameUrl(m.source,opp.href)&&m.markers.every(s=>body.includes(compact(s))));
 const confirmedUrls=mirror?[mirror.url]:[];
 // A fetched redirect is evidence, unlike a guessed URL or a similar title.
 if(read.finalUrl && read.finalUrl!==opp.href) confirmedUrls.push(read.finalUrl);
 const isHuntsville=sameUrl(opp.href,HUNTSVILLE_AD)&&['University of Alabama in Huntsville','26-27-141','Eminent Scholar'].every(s=>body.includes(compact(s)));
 if(!isHuntsville) return {opp,parsed:read.parsed,confirmedUrls};
 return {
  opp:{...opp,institution:'University of Alabama in Huntsville',title:'Eminent Scholar and Professor in Management of Technology'},
  parsed:{...read.parsed,ok:true,institution:'University of Alabama in Huntsville',
   title:'Eminent Scholar and Professor in Management of Technology',
   school:'College of Business',department:'Information Systems, Supply Chain, and Analytics',
   country:'United States',reviewDate:'2026-12-01',applyByDate:'',applyByProse:'Until filled.',
   description:'Eminent Scholar and Professor in Management of Technology, University of Alabama in Huntsville. Senior research and intellectual leadership, faculty mentorship, teaching and service. Vacancy log 26-27-141. Preferred application date: December 1, 2026; applications continue until filled. The POMS index incorrectly labels the university as University of Alabama; the linked employer advert identifies Huntsville.'},
  confirmedUrls
 };
}

// This decision is used both before queueing and after re-reading Firestore.
// Warning-only matches deliberately do not participate in it.
export function confirmedPomsRepeat(row, others, confirmedUrls = []) {
 for (const candidate of [row, ...confirmedUrls.map(adUrl => ({...row, adUrl}))]) {
  const match=publishedAdvertRepeat(candidate,others)||advertRepeat(candidate,others);
  if(match) return match;
 }
 return null;
}
