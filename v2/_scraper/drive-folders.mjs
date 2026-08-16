/* ---------------------------------------------------------------------------
   Operations Academia — which Drive folder a file belongs in.

   Uploads are filed by JOB MARKET YEAR, matching how the Drive is already
   organised: "Current JM" holds this season's "Jobs Files" and "Candidates
   Files", and each July the whole thing is archived into
   "Past JM data/<year> JM" and fresh folders are made.

   That archiving is exactly what makes this worth a module rather than two
   constants: the folder ids CHANGE every year, and the failure mode of getting
   it wrong is silent. A CV filed into last season's folder is not an error
   anyone sees — it is simply not where anybody looks, and nobody finds out
   until the season is over. So an upload for a year that has no entry is
   REFUSED, loudly, naming what to add.

   Pure and offline, so the selftest covers it.
   --------------------------------------------------------------------------- */

/** A Drive folder id: what Google puts after /folders/ in the URL. */
const ID_RE = /^[A-Za-z0-9_-]{20,}$/;

/** The placeholders the committed config ships with, before anyone fills it in. */
export function isPlaceholder(value) {
  return /^PASTE_/.test(String(value || ''));
}

export function isFolderId(value) {
  return ID_RE.test(String(value || ''));
}

export const KINDS = ['jobs', 'candidates'];

/**
 * The folder a file of `kind` goes in for `marketYear`.
 *
 * Throws rather than guessing. The message is written for whoever reads it in
 * a workflow log a year from now, so it says which season, which folder, and
 * what to do — not "undefined".
 */
export function folderFor(config, marketYear, kind) {
  if (!KINDS.includes(kind)) {
    throw new Error(`unknown upload kind "${kind}" — expected one of ${KINDS.join(', ')}`);
  }

  const year = String(marketYear);
  const table = (config && config.byMarketYear) || {};
  const entry = table[year];

  if (!entry) {
    const known = Object.keys(table).sort().join(', ') || '(none)';
    throw new Error(
      `no Drive folders configured for market year ${year}. ` +
      `Configured years: ${known}. ` +
      `The market rolls on 1 July, so this is expected the first time a season ` +
      `starts: create this season's folders in Drive, then add ` +
      `"${year}": { "jobs": "...", "candidates": "..." } to v2/data/drive-folders.json.`);
  }

  const id = entry[kind];

  if (isPlaceholder(id)) {
    throw new Error(
      `the ${kind} folder for market year ${year} is still the placeholder ` +
      `"${id}". Open "Current JM" in Drive, open the ` +
      `${kind === 'jobs' ? '"Jobs Files"' : '"Candidates Files"'} folder, and copy ` +
      `the part of the URL after /folders/ into v2/data/drive-folders.json.`);
  }

  if (!isFolderId(id)) {
    throw new Error(
      `the ${kind} folder id for market year ${year} does not look like a Drive ` +
      `folder id: ${JSON.stringify(id)}. It should be the part of the folder's ` +
      'URL after /folders/ — roughly 30 characters of letters, digits, - and _.');
  }

  return id;
}

/**
 * The resource key for a folder, or ''.
 *
 * Folders created before September 2021 carry one (the ?resourcekey= in their
 * URL), and Drive requires it — via the X-Goog-Drive-Resource-Keys header —
 * when access comes from a LINK rather than from ownership. Our token is the
 * owner's, so it should never be needed; it is sent anyway because the failure
 * it prevents is an opaque 404 that looks identical to a wrong folder id.
 */
export function resourceKeyFor(config, marketYear, kind) {
  const entry = ((config && config.byMarketYear) || {})[String(marketYear)] || {};
  const key = entry[kind + 'ResourceKey'];
  return isPlaceholder(key) ? '' : String(key || '');
}

/** The header value Drive wants: "<folderId>/<resourceKey>". '' when there is
    no key, in which case the header is omitted entirely rather than sent empty. */
export function resourceKeyHeader(config, marketYear, kind) {
  const key = resourceKeyFor(config, marketYear, kind);
  if (!key) return '';
  return folderFor(config, marketYear, kind) + '/' + key;
}

/**
 * Whether a season is ready to receive uploads. The upload UI asks this so it
 * can say "file uploads are not set up for this season yet" instead of letting
 * someone choose a file and fail at the last step.
 */
export function isConfigured(config, marketYear, kind) {
  try {
    folderFor(config, marketYear, kind);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every problem with the config at once, for a health check that reports
 * rather than stopping at the first fault.
 */
export function auditFolders(config, { years = [] } = {}) {
  const problems = [];
  const table = (config && config.byMarketYear) || {};
  const wanted = years.length ? years.map(String) : Object.keys(table);

  for (const year of wanted) {
    for (const kind of KINDS) {
      try {
        folderFor(config, year, kind);
      } catch (e) {
        problems.push(e.message);
      }
    }
  }
  return problems;
}
