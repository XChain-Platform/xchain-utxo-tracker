'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Build a minimal but structurally valid AuxPoW block hex for testing the
// structural-parse path (Dogecoin Core 1.14 behavior: getblockheader returns
// exactly 160 hex chars regardless of merge-mining status).
// AuxPoW layout after the 80-byte header:
//   coinbase tx (version 4B + nIns varint + input[prevout 36B + script 0B varint + seq 4B] + nOuts varint + output[value 8B + script 0B varint] + locktime 4B)
//   + parent block hash (32B) + coinbase branch (0 hashes, index 4B) + chain branch (0 hashes, index 4B) + parent header (80B)
function buildAuxPowBlockHex(txBodyHex) {
  // 80-byte standard header with AuxPoW version bit (0x100) set.
  // Version bytes in little-endian: 0x00000101 -> 01 01 00 00
  const standardHeader = '01010000' + '00'.repeat(76)  // version (4 B) + 76 B padding = 80 B total = 160 hex chars

  // Minimal coinbase tx: version(4) + nIns(1=0x01) + prevout(32 zeros + ffffffff) + scriptLen(0) + seq(ffffffff) + nOuts(1) + value(0 8B) + scriptLen(0) + locktime(4)
  const coinbaseTx = (
    '01000000'        +  // version (4 B)
    '01'              +  // nIns = 1
    '00'.repeat(32) + 'ffffffff' +  // prevout hash (32 B) + index (0xffffffff)
    '00'              +  // script length = 0
    'ffffffff'        +  // sequence
    '01'              +  // nOuts = 1
    '0000000000000000' + // value = 0
    '00'              +  // script length = 0
    '00000000'           // locktime
  )
  const parentBlockHash = '00'.repeat(32)  // 32 B
  const coinbaseBranch  = '00' + '00000000'  // nHashes=0, index=0
  const chainBranch     = '00' + '00000000'  // nHashes=0, index=0
  const parentHeader    = '00'.repeat(80)   // 80 B
  const auxPow = coinbaseTx + parentBlockHash + coinbaseBranch + chainBranch + parentHeader
  return standardHeader + auxPow + txBodyHex
}

// Parameterized variant that exercises the two AuxPoW branches real mainnet DOGE
// blocks hit but the 0-hash/non-segwit fixture above never does: a segwit-serialized
// parent coinbase (marker + flag + per-input witness stack) and multi-hash coinbase/
// chain merkle branches (count > 0). The offsets here are the mirror image of
// skipAuxPow()'s byte-walk, so any divergence in the segwit skip or the count*32+4
// branch arithmetic shifts the parent-header boundary and fails the round-trip below.
function buildAuxPowBlockHexEx(txBodyHex, { segwit = false, cbBranchHashes = 0, chainBranchHashes = 0 } = {}) {
  const standardHeader = '01010000' + '00'.repeat(76)  // version w/ AuxPoW bit (0x100) + 76 B = 80 B

  let coinbaseTx = (
    '01000000'        +                 // version (4 B)
    (segwit ? '0001' : '') +            // segwit marker (00) + flag (01)
    '01'              +                 // nIns = 1
    '00'.repeat(32) + 'ffffffff' +      // prevout hash (32 B) + index
    '00'              +                 // script length = 0
    'ffffffff'        +                 // sequence
    '01'              +                 // nOuts = 1
    '0000000000000000' +                // value = 0
    '00'                                // script length = 0
  )
  if (segwit) {
    // One witness stack for the single input: 1 item of 32 bytes (coinbase
    // witness reserved value), matching skipAuxPow's per-input stack walk.
    coinbaseTx += '01' + '20' + '00'.repeat(32)
  }
  coinbaseTx += '00000000'              // locktime

  const parentBlockHash = '00'.repeat(32)
  // varint count + count*32 B hashes + 4 B index; distinct byte fills per hash so a
  // miscount is not masked by repeated bytes.
  const branch = (n) => {
    let hex = n.toString(16).padStart(2, '0')
    for (let i = 0; i < n; i++) hex += (i + 1).toString(16).padStart(2, '0').repeat(32)
    return hex + '00000000'
  }
  const parentHeader = '00'.repeat(80)
  const auxPow = coinbaseTx + parentBlockHash + branch(cbBranchHashes) + branch(chainBranchHashes) + parentHeader
  return standardHeader + auxPow + txBodyHex
}

module.exports = { buildAuxPowBlockHex, buildAuxPowBlockHexEx };

