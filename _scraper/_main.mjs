/* ---------------------------------------------------------------------------
   Operations Academia — "am I the script being run, or a module being
   imported?", answered the same on every platform.

   Every CLI here used to decide by gluing "file://" onto process.argv[1]
   and comparing the result to import.meta.url — which is true on the Linux
   runners and NEVER true on Windows:
   `import.meta.url` is a URL ("file:///C:/Users/…/selftest.mjs", forward
   slashes, three slashes, percent-encoding) while `process.argv[1]` is a
   path ("C:\Users\…\selftest.mjs"), and gluing "file://" onto a path is not
   how one becomes the other. So on the maintainer's own machine — where the
   local modes exist to be run: --hosts --write, --heal-names, --apply-only,
   the whole selftest — every one of these scripts loaded, defined its
   functions, matched nothing, and exited 0 IN SILENCE. A no-op with a green
   exit code, which is this repository's least favourite failure shape
   (2026-08-24, found because the owner ran two commands and got two empty
   prompts back).

   The honest comparison converts BOTH sides to the same kind of thing and
   lets Node do the platform work: the module URL back to a path
   (fileURLToPath understands drive letters and decodes the escaping), both
   paths resolved, and Windows compared case-insensitively because its
   filesystems are. selftest.mjs pins that the broken pattern never returns
   and that every guard goes through here.
   --------------------------------------------------------------------------- */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** True when the module at `metaUrl` (pass `import.meta.url`) is the script
    node was asked to run. False under import — and false, never a throw, for
    anything odd (no argv, a non-file URL), because a guard that can crash
    its host module is worse than one that stands down. */
export function isMain(metaUrl) {
  const argv = process.argv[1];
  if (!argv) return false;
  let self;
  try {
    self = fileURLToPath(metaUrl);
  } catch {
    return false;
  }
  const a = path.resolve(self);
  const b = path.resolve(argv);
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}
