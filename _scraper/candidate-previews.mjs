import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const Card=require('../assets/oa-candcard.js');
const Schools=require('../assets/oa-schools.js');

/** School-only homepage previews. Never project a name, profile id or detail. */
export function candidatePreviews(rows) {
  return rows.slice().sort((a,b)=>
    (a.last||a.name?.trim().split(/\s+/).pop()||'').localeCompare(b.last||b.name?.trim().split(/\s+/).pop()||'','en',{sensitivity:'base'})
    || (a.first||a.name||'').localeCompare(b.first||b.name||'','en',{sensitivity:'base'})
  ).slice(0,10).map((r,i)=>({id:'candidate-preview-'+(i+1),year:r.year,
    affiliation:Card.universityName(r.affiliation,Schools.canonInstitution),previewOnly:true}));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const rows=Array.from({length:12},(_,i)=>({id:'private-person-'+i,year:2027,name:'Private Name '+i,last:String(i).padStart(2,'0'),affiliation:'Operations, Example University',cvUrl:'https://private.example/cv',email:'private@example.org',jobTalk:{title:'Private talk'}}));
  const preview=candidatePreviews(rows);
  assert.equal(preview.length,10);
  assert.deepEqual(Object.keys(preview[0]),['id','year','affiliation','previewOnly']);
  assert.equal(preview[0].affiliation,'Example University');
  assert.ok(!/Private|private|cvUrl|email|jobTalk/.test(JSON.stringify(preview)));
  assert.deepEqual(candidatePreviews([]),[]);
  console.log('candidate-previews: school-only projection checks passed');
}
