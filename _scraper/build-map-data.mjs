import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {isMain} from './_main.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url), schools=require('../assets/oa-schools.js');
// Research notes and secondary citations remain in school-map-locations.json;
// the initial map only needs the primary address evidence shown on each card.
export function compactLocationRecords(records){
 return records.map(({notes,supportingSources,...record})=>record);
}
export async function buildMapData({dryRun=false}={}){
 const read=async name=>JSON.parse(await readFile(path.join(root,'data',name),'utf8'));
 const [locations,historic,logos,verified,cardGroups]=await Promise.all(['university-map-locations.json','universities.json','university-logos.json','school-map-locations.json','map-card-groups.json'].map(read));
 const select=(r,fields)=>Object.fromEntries(fields.filter(k=>r[k]!==undefined&&r[k]!=='').map(k=>[k,r[k]]));
 const payload={
  rowInstitutions:locations.rowInstitutions,
  verified:compactLocationRecords(verified.records),
  schoolAliases:cardGroups.schoolAliases,
  locations:locations.records.map(r=>({...select(r,['name','lat','lng','country','logo','mapUrl']),key:schools.institutionKey(r.name)})),
  historic:historic.filter(r=>Number.isFinite(r.lat)&&Number.isFinite(r.lng)).map(r=>({...select(r,['institution','name','school','department','lat','lng','country','mapUrl']),key:schools.institutionKey(r.institution||r.name)})),
  logos:logos.records.map(r=>({name:r.name,key:schools.institutionKey(r.name),logo:r.logo}))
 };
 if(!dryRun)await writeFile(path.join(root,'data/university-map.json'),JSON.stringify(payload)+'\n');
 return payload;
}
if(isMain(import.meta.url))await buildMapData({dryRun:process.argv.includes('--dry-run')});
