import {readFile, unlink} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

export async function notifyPublishedChanges(message, published, deliver) {
  if (!published || !message) return false;
  await deliver(message);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--selftest')) {
    const sent=[];
    const deliver=async message=>sent.push(message);
    const message={subject:'One real edit'};
    assert.equal(await notifyPublishedChanges(message,false,deliver),false);
    assert.equal(await notifyPublishedChanges(null,true,deliver),false);
    assert.equal(sent.length,0);
    assert.equal(await notifyPublishedChanges(message,true,deliver),true);
    assert.deepEqual(sent,[message]);
    console.log('job change notifications: failed/unpublished builds send nothing; published changes send once');
  } else {
    if (!process.argv.includes('--published')) throw new Error('Notifications require successful publication');
    const reportPath=process.argv[2];
    try {
      const message=JSON.parse(await readFile(reportPath,'utf8'));
      const mail=await import('./_mail.mjs');
      await notifyPublishedChanges(message,true,async value=>mail.send(await mail.transport(),value));
      await unlink(reportPath);
    } catch(error) {
      if(error.code!=='ENOENT') console.warn('Published job change notification failed:',error.message);
    }
  }
}
