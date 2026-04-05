#!/usr/bin/env node
'use strict';

// Standalone runner for custom Buffer/encoding mutations.
//
// StrykerJS v8 does not expose a public plugin API for custom mutant
// generation. This script fills that gap by:
//
//   1. Generating custom mutants (endianness swaps, key prefix swaps)
//   2. Applying each mutation one at a time to the source file
//   3. Running the relevant Mocha test suite
//   4. Recording killed/survived status
//   5. Restoring the original source
//   6. Printing a summary report
//
// Usage:
//   node test/mutation/stryker-plugins/run-custom-mutants.js [--spec <glob>] [--timeout <ms>] [files...]
//
// Examples:
//   node test/mutation/stryker-plugins/run-custom-mutants.js
//   node test/mutation/stryker-plugins/run-custom-mutants.js src/LevelUpDb.js bufferutils.js
//   node test/mutation/stryker-plugins/run-custom-mutants.js --spec "test/unit/**/*.test.js" --timeout 10000

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { generate } = require('./buffer-mutator.cjs');

// ── CLI argument parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2);
let specGlob = 'test/unit/**/*.test.js';
let timeoutMs = 30000;
const files = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--spec' && args[i + 1]) {
    specGlob = args[++i];
  } else if (args[i] === '--timeout' && args[i + 1]) {
    timeoutMs = parseInt(args[++i], 10);
  } else if (!args[i].startsWith('--')) {
    files.push(args[i]);
  }
}

const DEFAULT_TARGETS = [
  'src/LevelUpDb.js',
  'src/XChainUtxoTracker.js',
  'bufferutils.js',
  'src/BlockchainConnector.js',
  'src/XChainBlockDecoder.js',
];

const targetFiles = files.length > 0 ? files : DEFAULT_TARGETS;

// ── Generate mutants ────────────────────────────────────────────────────────

const mutants = generate(targetFiles);

if (mutants.length === 0) {
  console.log('No custom mutants generated.');
  process.exit(0);
}

console.log(`Generated ${mutants.length} custom mutants across ${targetFiles.length} files\n`);

// ── Apply and test each mutant ──────────────────────────────────────────────

const results = { killed: 0, survived: 0, error: 0, timedOut: 0 };
const survivors = [];

for (let i = 0; i < mutants.length; i++) {
  const mutant = mutants[i];
  const absPath = path.resolve(mutant.fileName);
  const original = fs.readFileSync(absPath, 'utf8');

  // Apply mutation: replace text at the specified location
  const lines = original.split('\n');
  const { start, end } = mutant.location;

  // Convert location to flat offsets
  let startOffset = 0;
  for (let l = 0; l < start.line; l++) {
    startOffset += lines[l].length + 1; // +1 for \n
  }
  startOffset += start.column;

  let endOffset = 0;
  for (let l = 0; l < end.line; l++) {
    endOffset += lines[l].length + 1;
  }
  endOffset += end.column;

  const mutated = original.slice(0, startOffset) + mutant.replacement + original.slice(endOffset);

  // Write mutated file
  fs.writeFileSync(absPath, mutated, 'utf8');

  const label = `[${i + 1}/${mutants.length}] ${mutant.fileName}:${start.line + 1} ${mutant.mutatorName}: ${mutant.description}`;

  try {
    execSync(
      `npx mocha --timeout ${timeoutMs} --recursive "${specGlob}"`,
      {
        cwd: process.cwd(),
        stdio: 'pipe',
        timeout: timeoutMs * 2,
        env: { ...process.env, NODE_ENV: 'test' },
      }
    );
    // Tests passed -> mutation survived
    results.survived++;
    survivors.push(mutant);
    process.stdout.write(`  SURVIVED  ${label}\n`);
  } catch (err) {
    if (err.killed) {
      results.timedOut++;
      process.stdout.write(`  TIMEOUT   ${label}\n`);
    } else if (err.status !== null) {
      // Tests failed -> mutation killed
      results.killed++;
      process.stdout.write(`  KILLED    ${label}\n`);
    } else {
      results.error++;
      process.stdout.write(`  ERROR     ${label}\n`);
    }
  } finally {
    // Always restore original
    fs.writeFileSync(absPath, original, 'utf8');
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

const total = results.killed + results.survived + results.error + results.timedOut;
const detected = results.killed + results.timedOut + results.error;
const score = total > 0 ? ((detected / total) * 100).toFixed(1) : 'N/A';

console.log('\n' + '='.repeat(70));
console.log('CUSTOM MUTATION TESTING RESULTS (Buffer/Encoding)');
console.log('='.repeat(70));
console.log(`Total mutants:  ${total}`);
console.log(`Killed:         ${results.killed}`);
console.log(`Survived:       ${results.survived}`);
console.log(`Timed out:      ${results.timedOut}`);
console.log(`Errors:         ${results.error}`);
console.log(`Mutation score: ${score}%`);
console.log('='.repeat(70));

if (survivors.length > 0) {
  console.log('\nSURVIVED MUTANTS (test gaps):');
  console.log('-'.repeat(70));
  for (const s of survivors) {
    console.log(`  ${s.fileName}:${s.location.start.line + 1}  ${s.mutatorName}: ${s.description}`);
  }
  console.log('-'.repeat(70));
  console.log('Each survived mutant indicates a missing test assertion.');
}

process.exit(results.survived > 0 ? 1 : 0);
