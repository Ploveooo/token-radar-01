// Token Radar (model radar-3) — Node 22, standard library only.
//
// Reads the sealed snapshot at /input/snapshot.json (or --input <file|dir>), scores
// every rankable pre-token protocol with lib/model.ts, and writes the ranked board,
// the dashboard's data, the dashboard itself, three screenshots and the dossier the
// judge reads into /output (or MAKEFUN_OUTPUT_DIR).
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// The run is deterministic: the same snapshot bytes in give the same bytes out, so
// two runs write identical files.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;

/** Read `--name value` or `--name=value` from the arguments, else the fallback. */
function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = flag('input', '/input');
const snapshotPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  process.stderr.write(`token radar: no snapshot at ${snapshotPath} — pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const problem = boardIssue(board, snapshot);
if (problem !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${problem}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Copy a directory's regular files into `dest`, skipping dot-names; returns the names copied. */
function copyDir(from: string, dest: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(dest, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(dest, name));
    names.push(name);
  }
  return names;
}

const dashboardFiles = copyDir(join(here, 'dashboard'), join(outDir, 'dashboard'));
const shotFiles = copyDir(join(here, 'screenshots'), join(outDir, 'screenshots'));
if (shotFiles.length !== 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shotFiles.length} image${shotFiles.length === 1 ? '' : 's'}: hand in exactly 3 — the board, a detail view and a filtered view\n`);
  process.exit(1);
}
const badName = shotFiles.find((n) => !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(n));
if (badName !== undefined) {
  process.stderr.write(`token radar: screenshots/${badName} is not a plain file name\n`);
  process.exit(1);
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, { text_max_bytes: TEXT_MAX_BYTES, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }),
);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols in, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows ranked (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (${dashboardFiles.length} files), ${join(outDir, 'screenshots')} (${shotFiles.length} images), ${join(outDir, 'dossier.json')}\n`,
);
