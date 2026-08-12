/**
 * Print the version and content hash of the current creator terms.
 *
 * Run this whenever constants/terms.ts changes, and register the result in
 * public.tos_terms_versions. Acceptance rows copy their hash from that table,
 * so an acceptance can prove what the text actually said — which a version
 * string alone cannot, since a version string can be reused after an edit.
 *
 * Hashes termsPlainText(), the rendering the file already exports "for the
 * record". Hashing the source file instead would change the hash when a comment
 * or an import moved, which would falsely suggest the terms had changed.
 *
 *   node scripts/terms-hash.mjs
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(tmpdir(), `obelisk-terms-${Date.now()}.mjs`);

// constants/terms.ts is TypeScript, so it cannot be imported directly. esbuild
// is already a dependency of vite; this compiles just that one file.
await build({
  entryPoints: [join(root, 'constants', 'terms.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});

try {
  const { TERMS_VERSION, termsPlainText } = await import(pathToFileURL(out).href);
  const text = termsPlainText();
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');

  console.log(`version:      ${TERMS_VERSION}`);
  console.log(`content_hash: ${hash}`);
  console.log(`characters:   ${text.length}`);
  console.log();
  console.log('Register with:');
  console.log(
    `  insert into public.tos_terms_versions (version, content_hash)\n` +
    `  values ('${TERMS_VERSION}', '${hash}')\n` +
    `  on conflict (version) do nothing;`
  );
} finally {
  try { unlinkSync(out); } catch { /* best effort */ }
}
