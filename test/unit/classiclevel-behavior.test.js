'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Contract tests for the classic-level (LevelDB) behaviours that LevelUpDb.js
// relies on after the rocksdb→classic-level migration. These guard against a
// future classic-level upgrade silently changing semantics the indexer depends
// on (range boundaries, iterator snapshots, empty values, miss handling).
// Runs on-disk against the real engine (the production main-DB backend).

const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ClassicLevel } = require('classic-level')

const BUF = { keyEncoding: 'buffer', valueEncoding: 'buffer' }

describe('classic-level backend behaviour contract', function () {
  let db, dir

  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xch-cl-contract-'))
    db = new ClassicLevel(dir, BUF)
    await db.open()
  })

  afterEach(async function () {
    try { await db.close() } catch (e) { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
  })

  // --- miss handling: LevelUpDb depends on undefined (not throw) on a miss ---
  it('get() returns undefined for a missing key (does not throw)', async function () {
    const v = await db.get(Buffer.from([0x4f, 1, 2, 3]))
    expect(v).to.equal(undefined)
  })

  it('getMany() returns undefined for misses and values for hits, preserving order', async function () {
    await db.put(Buffer.from([0x42, 1]), Buffer.from('a'))
    await db.put(Buffer.from([0x42, 3]), Buffer.from('c'))
    const got = await db.getMany([
      Buffer.from([0x42, 1]),   // hit
      Buffer.from([0x42, 2]),   // miss
      Buffer.from([0x42, 3]),   // hit
    ])
    expect(got.length).to.equal(3)
    expect(got[0].toString()).to.equal('a')
    expect(got[1]).to.equal(undefined)
    expect(got[2].toString()).to.equal('c')
  })

  // --- empty values: N/J/Z prefixes store zero-length Buffers ---
  it('round-trips a zero-length value as a 0-length Buffer (not a deletion)', async function () {
    const k = Buffer.from([0x4e, 9, 9])
    await db.put(k, Buffer.alloc(0))
    const v = await db.get(k)
    expect(Buffer.isBuffer(v)).to.equal(true)
    expect(v.length).to.equal(0)
  })

  // --- range boundary: mirrors LevelUpDb.rangeEnd (prefix + 12 bytes of 0xFF) ---
  it('range scan with a 12-byte 0xFF upper bound includes keys ending in 0xFF', async function () {
    const P = 0x4f
    const inRangeFF = Buffer.concat([Buffer.from([P]), Buffer.alloc(12, 0xFF)]) // 13-byte key, all 0xFF tail
    const normal = Buffer.from([P, 0x10, 0x20])
    const outOfRange = Buffer.from([P + 1, 0x00])                                 // next prefix — must be excluded
    await db.batch([
      { type: 'put', key: normal, value: Buffer.from('n') },
      { type: 'put', key: inRangeFF, value: Buffer.from('f') },
      { type: 'put', key: outOfRange, value: Buffer.from('x') },
    ])
    const gte = Buffer.from([P])
    const lte = Buffer.concat([Buffer.from([P]), Buffer.alloc(12, 0xFF)])
    const keys = []
    for await (const [k] of db.iterator({ gte, lte, values: false })) keys.push(k.toString('hex'))
    expect(keys).to.include(normal.toString('hex'))
    expect(keys).to.include(inRangeFF.toString('hex'))                 // the boundary key must be captured
    expect(keys).to.not.include(outOfRange.toString('hex'))           // next prefix must be excluded
  })

  it('iterates keys in ascending byte order (and reverse:true descends)', async function () {
    const keys = [Buffer.from([0x4f, 0xFF]), Buffer.from([0x4f, 0x00]), Buffer.from([0x4f, 0x80])]
    await db.batch(keys.map(k => ({ type: 'put', key: k, value: Buffer.alloc(0) })))
    const asc = []
    for await (const [k] of db.iterator({ values: false })) asc.push(k.toString('hex'))
    expect(asc).to.deep.equal(['4f00', '4f80', '4fff'])
    const desc = []
    for await (const [k] of db.iterator({ values: false, reverse: true })) desc.push(k.toString('hex'))
    expect(desc).to.deep.equal(['4fff', '4f80', '4f00'])
  })

  // --- snapshot semantics: the reorg path deletes keys while an iterator is open ---
  it('iterator reflects a consistent snapshot despite a concurrent delete', async function () {
    const a = Buffer.from([0x4f, 1]), b = Buffer.from([0x4f, 2]), c = Buffer.from([0x4f, 3])
    await db.batch([
      { type: 'put', key: a, value: Buffer.from('a') },
      { type: 'put', key: b, value: Buffer.from('b') },
      { type: 'put', key: c, value: Buffer.from('c') },
    ])
    const it = db.iterator({ values: false })
    const seen = []
    const first = await it.next()              // open the snapshot, read one entry
    seen.push(first[0].toString('hex'))
    await db.del(b)                            // mutate AFTER the iterator snapshot was taken
    for (let e = await it.next(); e !== undefined; e = await it.next()) seen.push(e[0].toString('hex'))
    await it.close()
    // The snapshot must still include b even though it was deleted mid-iteration.
    expect(seen).to.include(b.toString('hex'))
    // And the delete is visible to a fresh read:
    expect(await db.get(b)).to.equal(undefined)
  })
})
