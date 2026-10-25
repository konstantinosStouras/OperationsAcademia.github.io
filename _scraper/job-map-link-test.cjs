const assert=require('node:assert/strict');
const nav=require('../assets/oa-jobnav.js');
const row={institution:'University College Dublin',school:'Michael Smurfit Graduate Business School',unit:'Management Information Systems',department:'Legacy department'};
const expected='https://www.operationsacademia.org/universities?'+new URLSearchParams({university:row.institution,focus:'department',school:row.school,department:row.unit});
for(const url of [
  'https://www.operationsacademia.org/universities',
  'https://operationsacademia.org/universities?filterA=old',
  'http://operationsacademia.org/universities.html?university=old&department=wrong&country=wrong',
  'https://www.operationsacademia.org/universities/#map',
  '//www.operationsacademia.org/universities?filterA=old',
  '/universities', '/universities.html?filterA=old',
  'universities', 'universities?filterA=old', './universities.html#map', '../universities?university=old',
  '  https://www.operationsacademia.org/universities  '
])assert.equal(nav.furtherInfoUrl({...row,furtherInfoUrl:url}),expected,url+' opens the posting department');
for(const url of [
  'https://university.example/jobs?department=Operations',
  'https://operationsacademia.org.evil.example/universities?filterA=old',
  'https://operationsacademia.org@evil.example/universities',
  'https://person:password@operationsacademia.org/universities',
  'https://operationsacademia.org:444/universities',
  'https://www.operationsacademia.org/jobs?university=old',
  '/department/universities', '/universities-extra',
  '?filterA=old', '#universities', '', 'mailto:department@example.edu',
  '  https://university.example/jobs  '
])assert.equal(nav.furtherInfoUrl({...row,furtherInfoUrl:url}),url,'unrelated destination remains unchanged: '+url);
const departmentOnly=nav.furtherInfoUrl({institution:'Example University',department:'Operations & Analytics',furtherInfoUrl:'/universities'});
assert.equal(new URL(departmentOnly).searchParams.get('department'),'Operations & Analytics');
assert.equal(new URL(departmentOnly).searchParams.has('school'),false);
const universityOnly=new URL(nav.furtherInfoUrl({institution:'Example University',furtherInfoUrl:'universities'}));
assert.equal(universityOnly.searchParams.get('focus'),'department');
assert.equal(universityOnly.searchParams.has('department'),false);
assert.equal(nav.furtherInfoUrl({furtherInfoUrl:'universities?university=Existing'}),'universities?university=Existing');
assert.equal(nav.furtherInfoUrl(null),'');
console.log('Job map links: bare, filtered and relative internal URLs target the posting department; external destinations preserved.');
