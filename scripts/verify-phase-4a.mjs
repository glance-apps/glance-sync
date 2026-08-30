// NEGATIVE CONTROL for Phase 4a: enforcement in the primitives.
//
// A passing test suite proves the code does what the tests say. It does not
// prove the tests would NOTICE if the code stopped doing it. This script
// removes each piece of enforcement from src/dbEngine.js in turn, runs the
// suite, and asserts it FAILS — then restores the file and asserts it passes
// again. A mutation that leaves the suite green is a hole in the tests, and
// this script reports it as a failure of the verification, not of the code.
//
// Run from the repo root:  node scripts/verify-phase-4a.mjs
//
// No servers, no network: this is pure source mutation plus vitest. The file
// is restored in a finally block and on SIGINT, and the script refuses to run
// against a dirty working copy of the file it mutates.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';

const TARGET = 'src/dbEngine.js';
const SUITE = 'test/dbEngine.test.js';

const original = readFileSync(TARGET, 'utf8');

// Refuse to run if the target already has uncommitted changes: a crash mid-run
// would otherwise be indistinguishable from the user's own edits.
const dirty = execSync(`git status --porcelain -- ${TARGET}`, { encoding: 'utf8' }).trim();
if (dirty) {
  console.error(`\n  ${TARGET} has uncommitted changes. Commit or stash before running the`);
  console.error('  negative control — it rewrites that file and restores it from memory.\n');
  process.exit(2);
}

const restore = () => writeFileSync(TARGET, original);
process.on('SIGINT', () => { restore(); process.exit(130); });

/**
 * Each mutation removes ONE protection. `find` must appear exactly once, so a
 * refactor that moves or renames the enforcement makes this script fail loudly
 * rather than silently testing nothing.
 */
const MUTATIONS = [
  {
    name: 'the push gate',
    what: 'pushDirtyRows no longer refuses while its window is open',
    find: "      guardWindow(pushBackoff, 'push');\n",
    replace: '',
  },
  {
    name: 'the pull gate',
    what: 'pullRemoteChanges no longer refuses while its window is open',
    find: "      guardWindow(pullBackoff, 'pull');\n",
    replace: '',
  },
  {
    name: 'the push recorder',
    what: 'a failed push no longer opens a window from inside the primitive',
    find: '      recordFailure(pushBackoff, err, MAX_PUSH_BACKOFF_S);\n      throw err;',
    replace: '      throw err;',
  },
  {
    name: 'the pull recorder',
    what: 'a failed pull no longer opens a window from inside the primitive',
    find: '      recordFailure(pullBackoff, err, MAX_PULL_BACKOFF_S);\n      throw err;',
    replace: '      throw err;',
  },
  {
    name: 'the halt guard',
    what: 'a halted device no longer refuses direct primitive calls',
    find: "      guardHalt('push');\n",
    replace: '',
  },
  {
    name: 'the halt setter in the push',
    what: 'a rejected credential seen by a direct push no longer sets the halt',
    find: "if (err && err.code === 'CREDENTIAL_INVALID' && !err.halted) noteCredentialRejection(err);\n      recordFailure(pushBackoff",
    replace: '      recordFailure(pushBackoff',
  },
  {
    name: 'the SYNC_SUPPRESSED do-not-delay rule',
    what: 'a suppressed call records a failure, so an open window feeds itself',
    find: "    if (code === 'SYNC_SUPPRESSED') return null;\n",
    replace: '',
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

// The failing test names, so the report says WHICH guard each test is holding.
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
  console.log('\n  Phase 4a negative control — every protection must be load-bearing\n');

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
      console.error('    The enforcement moved or was renamed; update this script.\n');
      holes += 1;
      continue;
    }

    writeFileSync(TARGET, original.replace(m.find, m.replace));
    const result = runSuite();
    restore();

    if (result.passed) {
      console.error(`  ✗ ${m.name}`);
      console.error(`      removed: ${m.what}`);
      console.error('      ...and the suite still PASSED. Nothing is guarding this.\n');
      holes += 1;
    } else {
      const names = failedNames(result.output);
      console.log(`  ✓ ${m.name}`);
      console.log(`      removed: ${m.what}`);
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
  console.error(`  ${holes} unguarded mutation${holes === 1 ? '' : 's'}. Phase 4a is not fully pinned.\n`);
  process.exit(1);
}
console.log(`  All ${MUTATIONS.length} protections are load-bearing.\n`);
