// Stamps dist/version.json with the commit that produced the build.
// Served as a static file (bypasses the SPA rewrite), so opening
// /version.json on the deployed site shows exactly which build is live.
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

let sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || '';
if (!sha) {
  try { sha = execSync('git rev-parse HEAD').toString().trim(); } catch { sha = 'unknown'; }
}

mkdirSync('dist', { recursive: true });
writeFileSync(
  'dist/version.json',
  JSON.stringify({ commit: sha.slice(0, 7), builtAt: new Date().toISOString() }, null, 2) + '\n'
);
console.log(`version.json → ${sha.slice(0, 7)}`);
