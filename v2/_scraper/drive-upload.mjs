#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — put a file into the Drive of operations.academia@gmail.com.

   WHY A USER TOKEN AND NOT A SERVICE ACCOUNT. A service account has no My Drive
   storage quota of its own, so uploading into a personal Gmail Drive fails with
   "Service Accounts do not have storage quota" even when the folder is shared
   with it. The standard trap. So this authenticates AS the account that owns
   the folders, with a refresh token minted once:

       GDRIVE_CLIENT_ID  GDRIVE_CLIENT_SECRET  GDRIVE_REFRESH_TOKEN

   THE SCOPE IS drive.file — per-file access, the only Drive scope Google
   classifies as non-sensitive, so no app verification. The app can touch only
   files it created; it cannot read, list or alter anything else in the Drive.
   That is also the one uncertainty in this design, which `--check` exists to
   settle: whether a per-file token may CREATE a file inside a folder it did not
   create. It should — the restriction is on reading, not on parenting — and
   --check proves it against the real folders rather than assuming.

       node v2/_scraper/drive-upload.mjs --check       # prove it works, clean up
       node v2/_scraper/drive-upload.mjs --check --keep # leave the probe file

   Nothing here is imported by the site. It is used by the upload function and
   by the check workflow.
   --------------------------------------------------------------------------- */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { marketYear } from './jobs-model.mjs';
import { folderFor, resourceKeyHeader, KINDS } from './drive-folders.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, '..', 'data', 'drive-folders.json');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';

/* ------------------------------------------------------------------- naming

   A file in a shared folder is only useful if its name says what it is without
   opening it. "advert.pdf" from forty schools is not a filing system.          */

/** Strip anything that makes a filename awkward in Drive or in a URL. */
export function safeName(s, max = 80) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/**
 * "2026-08-16 Tulane University — Freeman School of Business (OA-JOB-…).pdf"
 *
 * Date first so a folder sorts chronologically by name, institution next
 * because that is what anyone is scanning for, and the reference last so a
 * file can always be traced back to its posting.
 */
export function driveFileName({ posted, institution, department, ref, original }) {
  const ext = (String(original || '').match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0].toLowerCase();
  const parts = [
    safeName(posted, 10),
    safeName(institution, 60),
    department ? '— ' + safeName(department, 60) : '',
    ref ? `(${safeName(ref, 40)})` : '',
  ].filter(Boolean);
  return safeName(parts.join(' '), 180) + ext;
}

/* ------------------------------------------------------------------- errors

   Drive's failures all arrive as a status code and a sentence. Turning them
   into something that says what to DO is the difference between a five-minute
   fix and an afternoon.                                                       */

export function explain(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body || {});

  if (status === 401) {
    return 'Drive rejected the credentials (401). Either GDRIVE_REFRESH_TOKEN is ' +
      'wrong, or it has been revoked. The commonest cause: the OAuth consent ' +
      'screen is still in "Testing", where Google expires refresh tokens after ' +
      '7 days — publish it under Google Auth Platform > Audience and mint a new one.';
  }
  if (status === 403 && /insufficient/i.test(text)) {
    return 'The token does not carry the drive.file scope (403). Re-mint it in the ' +
      'OAuth Playground with https://www.googleapis.com/auth/drive.file.';
  }
  if (status === 403 && /quota|storage/i.test(text)) {
    return 'Drive refused for storage reasons (403). If this mentions service ' +
      'accounts, the token is for a service account rather than for ' +
      'operations.academia@gmail.com — service accounts have no My Drive quota. ' +
      'Otherwise the account is out of its 15 GB.';
  }
  if (status === 404) {
    return 'Drive could not find the folder (404). Either the id in ' +
      'v2/data/drive-folders.json is wrong, or the drive.file scope cannot ' +
      'create files inside a folder it did not create. If the id is right, that ' +
      'second case is the one to act on — it needs a different approach, not a ' +
      'different id.';
  }
  if (status === 429 || status >= 500) {
    return `Drive is temporarily unavailable (${status}). Retrying later should work.`;
  }
  return `Drive refused the request (${status}): ${text.slice(0, 400)}`;
}

class DriveError extends Error {
  constructor(status, body) {
    super(explain(status, body));
    this.status = status;
    this.body = body;
  }
}

/* ---------------------------------------------------------------- the client */

/** An access token from the stored refresh token. Short-lived; not cached. */
export async function accessToken(env = process.env) {
  const id = env.GDRIVE_CLIENT_ID;
  const secret = env.GDRIVE_CLIENT_SECRET;
  const refresh = env.GDRIVE_REFRESH_TOKEN;
  if (!id || !secret || !refresh) return null;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new DriveError(res.status, body);
  return body.access_token;
}

/** The multipart/related body Drive wants for metadata + bytes in one request. */
export function multipartBody(metadata, bytes, contentType, boundary) {
  const head = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    `--${boundary}\r\n` +
    `Content-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return Buffer.concat([head, Buffer.from(bytes), tail]);
}

/**
 * Upload one file. Returns { id, name, webViewLink }.
 *
 * `webViewLink` is what goes on the posting — the "open in Drive" URL, which is
 * what a reader wants, rather than a direct download.
 */
export async function uploadFile({
  token, folderId, resourceKey, name, bytes, contentType,
}) {
  const boundary = 'oa-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const metadata = { name, parents: [folderId] };

  const headers = {
    authorization: 'Bearer ' + token,
    'content-type': `multipart/related; boundary=${boundary}`,
  };
  // Only when the folder has one — see drive-folders.mjs.
  if (resourceKey) headers['X-Goog-Drive-Resource-Keys'] = resourceKey;

  const res = await fetch(
    `${UPLOAD_URL}?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`,
    { method: 'POST', headers, body: multipartBody(metadata, bytes, contentType, boundary) });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new DriveError(res.status, body);
  return body;
}

export async function deleteFile({ token, id }) {
  const res = await fetch(`${FILES_URL}/${encodeURIComponent(id)}?supportsAllDrives=true`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer ' + token },
  });
  if (!res.ok && res.status !== 404) {
    throw new DriveError(res.status, await res.text().catch(() => ''));
  }
}

/* --------------------------------------------------------------------- check */

async function check({ keep = false } = {}) {
  const config = JSON.parse(await readFile(CONFIG, 'utf8'));
  const year = marketYear(new Date());
  console.log(`market year ${year}`);

  const token = await accessToken();
  if (!token) {
    console.log('::error::GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN ' +
      'are not all set in this environment — nothing was checked.');
    process.exit(1);
  }
  console.log('credentials: exchanged the refresh token for an access token OK');

  let bad = 0;
  for (const kind of KINDS) {
    let folder;
    try {
      folder = folderFor(config, year, kind);
    } catch (e) {
      console.log(`::error::${kind}: ${e.message}`);
      bad++;
      continue;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      const file = await uploadFile({
        token,
        folderId: folder,
        resourceKey: resourceKeyHeader(config, year, kind),
        name: `OA upload check ${stamp}.txt`,
        bytes: Buffer.from(
          'Written by v2/_scraper/drive-upload.mjs --check to prove that uploads ' +
          'reach this folder. Safe to delete.\n'),
        contentType: 'text/plain',
      });
      console.log(`${kind}: wrote "${file.name}" into ${folder}`);
      console.log(`  ${file.webViewLink}`);

      if (keep) {
        console.log('  --keep: left in place, delete it yourself');
      } else {
        await deleteFile({ token, id: file.id });
        console.log('  and removed it again');
      }
    } catch (e) {
      console.log(`::error::${kind}: ${e.message}`);
      bad++;
    }
  }

  if (bad) {
    console.log(`::error::${bad} of ${KINDS.length} folders failed — uploads would not work.`);
    process.exit(1);
  }
  console.log('Drive uploads are working for both folders.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = new Set(process.argv.slice(2));
  if (argv.has('--check')) {
    await check({ keep: argv.has('--keep') });
  } else {
    console.log('Usage: node v2/_scraper/drive-upload.mjs --check [--keep]');
    process.exit(1);
  }
}
