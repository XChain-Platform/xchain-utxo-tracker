'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Custom Stryker mutator plugin for Buffer/encoding-specific mutations.
 *
 * Covers two mutation categories that StrykerJS built-in operators do not:
 *
 * 1. Endianness swaps  - e.g. writeUInt32BE <-> writeUInt32LE
 *    LevelUpDb.js uses BE for key sort order; bufferutils.js uses LE for
 *    Bitcoin wire format. Swapping one to the other is a subtle, high-impact
 *    mutation that must be caught by the test suite.
 *
 * 2. Key prefix byte swaps - e.g. P_OUTPUT (0x4F) <-> P_INPUT (0x49)
 *    Restricted to lines containing "const P_" to avoid false matches.
 *    A prefix swap causes lookups to scan the wrong LevelDB namespace.
 */

const ENDIANNESS_RULES = [
  { from: 'writeUInt32BE',    to: 'writeUInt32LE' },
  { from: 'writeUInt32LE',    to: 'writeUInt32BE' },
  { from: 'writeInt32BE',     to: 'writeInt32LE' },
  { from: 'writeInt32LE',     to: 'writeInt32BE' },
  { from: 'readUInt32BE',     to: 'readUInt32LE' },
  { from: 'readUInt32LE',     to: 'readUInt32BE' },
  { from: 'readInt32BE',      to: 'readInt32LE' },
  { from: 'readInt32LE',      to: 'readInt32BE' },
  { from: 'writeBigUInt64BE', to: 'writeBigUInt64LE' },
  { from: 'writeBigUInt64LE', to: 'writeBigUInt64BE' },
  { from: 'readBigUInt64BE',  to: 'readBigUInt64LE' },
  { from: 'readBigUInt64LE',  to: 'readBigUInt64BE' },
  { from: 'writeBigInt64BE',  to: 'writeBigInt64LE' },
  { from: 'writeBigInt64LE',  to: 'writeBigInt64BE' },
  { from: 'readBigInt64BE',   to: 'readBigInt64LE' },
  { from: 'readBigInt64LE',   to: 'readBigInt64BE' },
];

const PREFIX_RULES = [
  { from: '0x42', to: '0x54' },  // P_BLOCK (B) <-> P_TX (T)
  { from: '0x54', to: '0x42' },
  { from: '0x49', to: '0x4F' },  // P_INPUT (I) <-> P_OUTPUT (O)
  { from: '0x4F', to: '0x49' },
  { from: '0x48', to: '0x4A' },  // P_OUT_HINT (H) <-> P_IN_HINT (J)
  { from: '0x4A', to: '0x48' },
  { from: '0x53', to: '0x5A' },  // P_SCRIPT_BLK (S) <-> P_BLK_SCRIPT (Z)
  { from: '0x5A', to: '0x53' },
  { from: '0x4B', to: '0x4D' },  // P_OUT_DEL (K) <-> P_HINT_DEL (M)
  { from: '0x4D', to: '0x4B' },
];

/**
 * Convert a flat string offset to { line, column } (0-based).
 */
function offsetToLocation(source, offset) {
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (source[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline - 1 };
}

/**
 * Check if a position falls inside a line comment (// ...).
 */
function isInLineComment(source, matchIdx) {
  const lineStart = source.lastIndexOf('\n', matchIdx - 1) + 1;
  const before = source.slice(lineStart, matchIdx);
  return before.includes('//');
}

/**
 * Check if a position falls inside a block comment.
 */
function isInBlockComment(source, matchIdx) {
  let lastOpen = source.lastIndexOf('/*', matchIdx);
  if (lastOpen === -1) return false;
  let lastClose = source.lastIndexOf('*/', matchIdx);
  return lastClose < lastOpen;
}

/**
 * Check if the line at the given offset contains a specific substring.
 */
function lineContains(source, offset, needle) {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = source.indexOf('\n', offset);
  const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
  return line.includes(needle);
}

/**
 * Check if a position falls inside a string literal.
 */
function isInString(source, matchIdx) {
  const lineStart = source.lastIndexOf('\n', matchIdx - 1) + 1;
  const before = source.slice(lineStart, matchIdx);
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = 0; i < before.length; i++) {
    const ch = before[i];
    if (ch === '\\') { i++; continue; }
    if (ch === "'" && !inDouble && !inTemplate) inSingle = !inSingle;
    if (ch === '"' && !inSingle && !inTemplate) inDouble = !inDouble;
    if (ch === '`' && !inSingle && !inDouble) inTemplate = !inTemplate;
  }
  return inSingle || inDouble || inTemplate;
}

/**
 * Generate mutants for a single source file.
 *
 * @param {string} source - File content
 * @param {string} fileName - Relative file path
 * @returns {Array} Array of mutant descriptor objects
 */
function generateMutantsForFile(source, fileName) {
  const mutants = [];

  // Endianness swaps - apply to all source files
  for (const rule of ENDIANNESS_RULES) {
    let searchFrom = 0;
    while (true) {
      const idx = source.indexOf(rule.from, searchFrom);
      if (idx === -1) break;
      searchFrom = idx + 1;

      if (isInLineComment(source, idx) || isInBlockComment(source, idx) || isInString(source, idx)) {
        continue;
      }

      const start = offsetToLocation(source, idx);
      const end = offsetToLocation(source, idx + rule.from.length);

      mutants.push({
        mutatorName: 'BufferEndianness',
        replacement: rule.to,
        location: { start, end },
        description: `${rule.from} -> ${rule.to}`,
      });
    }
  }

  // Key prefix swaps - only on lines declaring P_* constants
  for (const rule of PREFIX_RULES) {
    let searchFrom = 0;
    while (true) {
      const idx = source.indexOf(rule.from, searchFrom);
      if (idx === -1) break;
      searchFrom = idx + 1;

      if (isInLineComment(source, idx) || isInBlockComment(source, idx) || isInString(source, idx)) {
        continue;
      }

      if (!lineContains(source, idx, 'const P_')) {
        continue;
      }

      const start = offsetToLocation(source, idx);
      const end = offsetToLocation(source, idx + rule.from.length);

      mutants.push({
        mutatorName: 'BufferKeyPrefix',
        replacement: rule.to,
        location: { start, end },
        description: `${rule.from} -> ${rule.to} (key prefix swap)`,
      });
    }
  }

  return mutants;
}

// Stryker v8 discovers custom plugins by requiring the module listed in the
// "plugins" config array, and expects a `strykerPlugins` array of
// { kind, name, factory } objects. It exposes no public "MutantGenerator"
// kind for external plugins, so this file exports an empty plugin list (to
// satisfy the loader without error) plus a standalone `generate()` function
// that a wrapper script drives instead of Stryker's own mutation pipeline
// (see run-custom-mutants.js).

const fs = require('fs');
const path = require('path');

/**
 * Standalone entry point: scan source files and return all custom mutants.
 *
 * Usage from CLI:
 *   node stryker-plugins/buffer-mutator.cjs [file1.js file2.js ...]
 *
 * If no files are specified, scans default targets.
 *
 * @param {string[]} files - Absolute or relative file paths to scan
 * @returns {Array} All generated mutants across all files
 */
function generate(files) {
  const allMutants = [];
  for (const filePath of files) {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) continue;
    const source = fs.readFileSync(absPath, 'utf8');
    const relPath = path.relative(process.cwd(), absPath);
    const mutants = generateMutantsForFile(source, relPath);
    for (const m of mutants) {
      m.fileName = relPath;
    }
    allMutants.push(...mutants);
  }
  return allMutants;
}

const DEFAULT_TARGETS = [
  'src/LevelUpDb.js',
  'src/XChainUtxoTracker.js',
  'src/bufferutils.js',
  'src/api.js',
  'src/BlockchainConnector.js',
  'src/XChainBlockDecoder.js',
];

// CLI invocation: print mutants as JSON
if (require.main === module) {
  const files = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_TARGETS;
  const mutants = generate(files);
  console.log(JSON.stringify(mutants, null, 2));
  console.error(`\nGenerated ${mutants.length} custom mutants across ${files.length} files`);
  process.exit(0);
}

// Stryker v8 loads this module as a plugin; the empty strykerPlugins array
// lets it load without error (see the file-level note above for why this
// isn't a real MutantGenerator plugin).
module.exports = {
  strykerPlugins: [],
  generate,
  generateMutantsForFile,
};
