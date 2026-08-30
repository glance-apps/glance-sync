// NEGATIVE CONTROL for Phase 4b: the pull-cursor durability contract.
//
// Same discipline as scripts/verify-phase-4a.mjs, and the same suspicion —
// 4a's control found a rule that was unreachable defensive code, passing not
// because it worked but because nothing could reach it. A mode test is
// especially prone to passing incidentally: assert only "the cursor is 0" and
// a mode that never writes ANYTHING satisfies it for the wrong reason.
//
// So this runs two kinds of mutation:
//
//   1. REMOVE a mode's handling — the suite must fail.
//   2. COLLAPSE one mode into another (make every mode behave like 'per-page',
//      or like 'caller') — the suite must fail. This is what proves each
//      mode's assertion discriminates, rather than passing because two modes
//      happen to agree on the scenario.
//
// Run from the repo root:  node scripts/verify-phase-4b.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';

const TARGET = 'src/dbEngine.js';
const SUITE = 'test/dbEngine.test.js';

const original = readFileSync(TARGET, 'utf8');

const dirty = execSync(`git status --porcelain -- ${TARGET}`, { encoding: 'utf8' }).trim();
if (dirty) {
  console.error(`\n  ${TARGET} has uncommitted changes. Commit or stash before running the`);
  console.error('  negative control — it rewrites that file and restores it from memory.\n');
  process.exit(2);
}

const restore = () => writeFileSync(TARGET, original);
process.on('SIGINT', () => { restore(); process.exit(130); });

const PER_PAGE_WRITE = `      if (pullCursorCommit === 'per-page') {
        setHighWaterMark(Math.max(getHighWaterMark(), maxSeq));
      }`;
const END_OF_PULL_WRITE = `    if (pullCursorCommit !== 'caller') {
      setHighWaterMark(Math.max(getHighWaterMark(), maxSeq));
    }`;
const CYCLE_COMMIT = `      if (pullCursorCommit === 'caller' && typeof pull.maxSeq === 'number') {
        setHighWaterMark(Math.max(getHighWaterMark(), pull.maxSeq));
      }`;
const VALIDATION = `  if (!PULL_CURSOR_MODES.includes(pullCursorCommit)) {`;

const MUTATIONS = [
  {
    name: 'the per-page commit point',
    what: "'per-page' stops advancing mid-pagination — the 1.10.0 convergence fix is gone",
    find: PER_PAGE_WRITE,
    replace: '',
  },
  {
    name: 'the end-of-pull commit point',
    what: 'no mode ever advances the cursor, so every caller re-pulls forever',
    find: END_OF_PULL_WRITE,
    replace: '',
  },
  {
    name: "the cycle's 'caller'-mode commit",
    what: "declaring 'caller' and using dbSyncCycle never converges",
    find: CYCLE_COMMIT,
    replace: '',
  },
  {
    name: 'the mode validation',
    what: 'an unrecognised mode falls back to a default instead of being refused',
    find: VALIDATION,
    replace: '  if (false) {',
  },
  // ── The discrimination mutations ──────────────────────────────────────────
  {
    name: 'DISCRIMINATION: collapse every mode into per-page',
    what: "'end-of-pull' and 'caller' silently behave like the unsafe default they replaced",
    find: PER_PAGE_WRITE,
    replace: `      if (true) {
        setHighWaterMark(Math.max(getHighWaterMark(), maxSeq));
      }`,
  },
  {
    name: "DISCRIMINATION: collapse every mode into caller",
    what: 'no mode writes the cursor, which a "cursor stayed at 0" assertion alone would not notice',
    find: END_OF_PULL_WRITE,
    replace: `    if (false) {
      setHighWaterMark(Math.max(getHighWaterMark(), maxSeq));
    }`,
  },
  {
    name: "DISCRIMINATION: make 'end-of-pull' write per-page too",
    what: "the default silently becomes the unsafe path for everyone who said nothing",
    find: PER_PAGE_WRITE,
    replace: `      if (pullCursorCommit !== 'caller') {
        setHighWaterMark(Math.max(getHighWaterMark(), maxSeq));
      }`,
  },
];

const runSuite = () => {
  try {
    execFileSync('npx', ['vitest', 'run', SUITE], { stdio: 'pipe', encoding: 'utf8' });
    return { passed: true, output: '' };
  } catch (err) {
    return { passed: false, output: `${err.stdout || ''}${err.stderr || ''}` };
  }
};

const failedNames = (output) => {
  const names = new Set();
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*(?:×|✕)\s+(.*?)(?:\s+\d+ms)?$/);
    if (m) names.add(m[1].trim());
  }
  return [...names];
};

let holes = 0;

try {
  console.log('\n  Phase 4b negative control — each mode must be load-bearing AND discriminating\n');

  const baseline = runSuite();
  if (!baseline.passed) {
    console.error('  BASELINE FAILS. Fix the suite before running the negative control.\n');
    console.error(baseline.output.slice(-4000));
    process.exit(1);
  }
  console.log('  baseline ................................. suite passes\n');

  for (const m of MUTATIONS) {
    const occurrences = original.split(m.find).length - 1;
    if (occurrences !== 1) {
      console.error(`  ✗ ${m.name}: anchor matched ${occurrences} times, expected exactly 1.`);
      console.error('    The code moved or was reshaped; update this script.\n');
      holes += 1;
      continue;
    }

    writeFileSync(TARGET, original.replace(m.find, m.replace));
    const result = runSuite();
    restore();

    if (result.passed) {
      console.error(`  ✗ ${m.name}`);
      console.error(`      effect: ${m.what}`);
      console.error('      ...and the suite still PASSED. Nothing discriminates this.\n');
      holes += 1;
    } else {
      const names = failedNames(result.output);
      console.log(`  ✓ ${m.name}`);
      console.log(`      effect: ${m.what}`);
      console.log(`      caught by ${names.length} test${names.length === 1 ? '' : 's'}:`);
      for (const n of names.slice(0, 3)) console.log(`        · ${n}`);
      if (names.length > 3) console.log(`        · (+${names.length - 3} more)`);
      console.log('');
    }
  }

  const after = runSuite();
  if (!after.passed) {
    console.error('  RESTORE FAILED: the suite does not pass with the original file.\n');
    process.exit(1);
  }
  console.log('  restored ................................. suite passes again\n');
} finally {
  restore();
}

if (holes > 0) {
  console.error(`  ${holes} mutation${holes === 1 ? '' : 's'} went unnoticed. Phase 4b is not fully pinned.\n`);
  process.exit(1);
}
console.log(`  All ${MUTATIONS.length} mutations caught: every mode is load-bearing and discriminating.\n`);
