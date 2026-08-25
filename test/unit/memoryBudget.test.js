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
 *
 * The two sizes derived here decide whether a backfill finishes or the
 * process is killed, and the failure is asymmetric: too small only costs
 * cache hits, too large costs the whole run and every restart after it.
 *
 * Two properties carry the weight. A container's cgroup limit must win
 * over host RAM, because os.totalmem() inside a container reports the
 * host and a `--memory 2g` tracker that sized itself off 64 GB dies in a
 * restart loop that never advances (measured: 25 kills in an hour at
 * 1.95 GB). And a host at or above 16 GB must derive exactly the two
 * constants this replaced, so an already-tuned server deployment does
 * not silently change behavior when it upgrades.
 *
 ********************************************************************/

'use strict'

const { expect } = require('chai')
const os = require('os')
const fs = require('fs')
const path = require('path')

const MODULE_PATH = path.resolve(__dirname, '../../src/memoryBudget.js')
const GIB = 1024 * 1024 * 1024
const MIB = 1024 * 1024

// Load a fresh copy of the module against a stubbed host size and cgroup
// state. cgroupBytes null means no cgroup file is readable at all, which is
// what a bare-metal host looks like.
function loadWith({ hostGiB, cgroupBytes = null, cgroupRaw = null, version = 'v2' }) {
    const realTotalmem = os.totalmem
    const realReadFileSync = fs.readFileSync
    const v2Path = '/sys/fs/cgroup/memory.max'
    const v1Path = '/sys/fs/cgroup/memory/memory.limit_in_bytes'
    const activePath = version === 'v1' ? v1Path : v2Path

    os.totalmem = () => hostGiB * GIB
    fs.readFileSync = (p, enc) => {
        if (typeof p === 'string' && p.startsWith('/sys/fs/cgroup')) {
            if (p === activePath && (cgroupBytes !== null || cgroupRaw !== null)) {
                return cgroupRaw !== null ? cgroupRaw : String(cgroupBytes)
            }
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        return realReadFileSync(p, enc)
    }

    delete require.cache[require.resolve(MODULE_PATH)]
    const mod = require(MODULE_PATH)
    const snapshot = {
        budgetBytes: mod.budgetBytes(),
        cacheBytes: mod.leveldbCacheBytes(),
        heapFlushMB: mod.heapFlushThresholdMB(),
        bulkSyncMB: mod.bulkSyncRamBudgetMB(),
        description: mod.describe(),
        describeInjected: mod.describe(777)
    }

    os.totalmem = realTotalmem
    fs.readFileSync = realReadFileSync
    delete require.cache[require.resolve(MODULE_PATH)]
    return snapshot
}

describe('utxo-tracker memory budget', function () {

    afterEach(function () {
        delete process.env.LEVELDB_CACHE_BYTES
        delete process.env.HEAP_FLUSH_THRESHOLD_MB
    })

    describe('a capped container sizes against the cap, not the host', function () {

        it('derives from the cgroup v2 limit when it binds below host RAM', function () {
            const { budgetBytes, cacheBytes, heapFlushMB } = loadWith({ hostGiB: 64, cgroupBytes: 2 * GIB })
            expect(budgetBytes).to.equal(2 * GIB)
            // The whole point: cache plus the flush trigger must leave real room
            // under the cap, or the kernel OOM-kills before any flush runs.
            expect(cacheBytes).to.equal(512 * MIB)
            expect(heapFlushMB).to.equal(256)
            expect(cacheBytes + heapFlushMB * MIB).to.be.below(2 * GIB * 0.5)
        })

        it('reads the cgroup v1 limit file when v2 is absent', function () {
            const { budgetBytes } = loadWith({ hostGiB: 64, cgroupBytes: 2 * GIB, version: 'v1' })
            expect(budgetBytes).to.equal(2 * GIB)
        })

        it('ignores a cgroup limit that does not bind below host RAM', function () {
            const { budgetBytes } = loadWith({ hostGiB: 8, cgroupBytes: 64 * GIB })
            expect(budgetBytes).to.equal(8 * GIB)
        })

        it('treats cgroup v2 "max" as unlimited rather than parsing it as a size', function () {
            const { budgetBytes } = loadWith({ hostGiB: 8, cgroupRaw: 'max' })
            expect(budgetBytes).to.equal(8 * GIB)
        })

        it('ignores the cgroup v1 unlimited sentinel, which exceeds host RAM', function () {
            const { budgetBytes } = loadWith({ hostGiB: 8, cgroupRaw: '9223372036854771712', version: 'v1' })
            expect(budgetBytes).to.equal(8 * GIB)
        })

        it('falls back to host RAM when no cgroup file is readable', function () {
            const { budgetBytes } = loadWith({ hostGiB: 8 })
            expect(budgetBytes).to.equal(8 * GIB)
        })
    })

    describe('a large server keeps the sizes it already runs', function () {

        // 4 GiB cache and a 2048 MB flush threshold were the shipped constants.
        // Anything at or above 16 GB must still derive exactly those.
        for (const hostGiB of [16, 32, 64, 256]) {
            it(`derives the former constants unchanged on a ${hostGiB} GB host`, function () {
                const { cacheBytes, heapFlushMB } = loadWith({ hostGiB })
                expect(cacheBytes).to.equal(4096 * MIB)
                expect(heapFlushMB).to.equal(2048)
            })
        }
    })

    describe('a small host scales down instead of claiming the machine', function () {

        it('halves the cache on an 8 GB board', function () {
            const { cacheBytes, heapFlushMB } = loadWith({ hostGiB: 8 })
            expect(cacheBytes).to.equal(2048 * MIB)
            expect(heapFlushMB).to.equal(1024)
        })

        it('never derives a cache larger than a quarter of the budget', function () {
            for (const hostGiB of [1, 2, 4, 8, 16, 64]) {
                const { budgetBytes, cacheBytes } = loadWith({ hostGiB })
                expect(cacheBytes).to.be.at.most(budgetBytes / 4)
            }
        })

        it('holds a floor so a tiny host still caches something', function () {
            const { cacheBytes, heapFlushMB } = loadWith({ hostGiB: 1 })
            expect(cacheBytes).to.be.at.least(128 * MIB)
            expect(heapFlushMB).to.equal(256)
        })
    })

    describe('an explicit operator value always wins', function () {

        it('takes LEVELDB_CACHE_BYTES verbatim over the derivation', function () {
            process.env.LEVELDB_CACHE_BYTES = String(64 * MIB)
            const { cacheBytes } = loadWith({ hostGiB: 64 })
            expect(cacheBytes).to.equal(64 * MIB)
        })

        it('takes HEAP_FLUSH_THRESHOLD_MB verbatim over the derivation', function () {
            process.env.HEAP_FLUSH_THRESHOLD_MB = '333'
            const { heapFlushMB } = loadWith({ hostGiB: 64 })
            expect(heapFlushMB).to.equal(333)
        })

        it('ignores an unusable override rather than sizing the cache at zero', function () {
            process.env.LEVELDB_CACHE_BYTES = 'not-a-number'
            const { cacheBytes } = loadWith({ hostGiB: 8 })
            expect(cacheBytes).to.equal(2048 * MIB)
        })
    })

    // The budget stopped at the process boundary: bulk-sync runs in a spawned
    // orchestrator whose external sort was handed a flat 4096 MB no matter what
    // the cgroup said, so a 2 GB tracker asked its own child to sort against
    // twice the whole limit and the kernel killed it at the merge, twice, on the
    // one path an operator only reaches after something has already gone wrong.
    describe('the bulk-sync child is sized by the same budget as its parent', function () {

        it('gives a 2 GB container a sort budget that fits inside it', function () {
            const { bulkSyncMB, cacheBytes, heapFlushMB } = loadWith({ hostGiB: 64, cgroupBytes: 2 * GIB })
            expect(bulkSyncMB).to.equal(1024)
            // The parent is still resident while the child sorts, so the two
            // together have to leave headroom under the cap.
            expect(bulkSyncMB * MIB + cacheBytes + heapFlushMB * MIB).to.be.below(2 * GIB)
        })

        it('never hands the child more than the budget it must fit inside', function () {
            for (const hostGiB of [1, 2, 4, 8, 16, 64, 256]) {
                const { budgetBytes, bulkSyncMB } = loadWith({ hostGiB })
                expect(bulkSyncMB * MIB).to.be.at.most(budgetBytes / 2)
            }
        })

        it('keeps the former flat 4096 on any host large enough to have meant it', function () {
            for (const hostGiB of [8, 16, 64, 256]) {
                const { bulkSyncMB } = loadWith({ hostGiB })
                expect(bulkSyncMB).to.equal(4096)
            }
        })

        it('scales down on the 8 GB board this was reported from', function () {
            // 8 GB of RAM, ~7801 MB visible to the OS: half of that, not 4096
            // plus the parent's own cache on top of it.
            const { bulkSyncMB } = loadWith({ hostGiB: 7.62 })
            expect(bulkSyncMB).to.be.below(4096)
            expect(bulkSyncMB).to.be.at.least(3000)
        })

        it('holds a floor so a tiny host still gets a workable sort budget', function () {
            const { bulkSyncMB } = loadWith({ hostGiB: 64, cgroupBytes: 512 * MIB })
            expect(bulkSyncMB).to.equal(512)
        })

        it('names the child budget in the startup line', function () {
            const { description } = loadWith({ hostGiB: 64, cgroupBytes: 2 * GIB })
            expect(description).to.contain('bulk-sync RAM budget 1024MB')
        })
    })

    describe('the startup line names what bound the budget', function () {

        it('says cgroup limit when the container cap is what binds', function () {
            const { description } = loadWith({ hostGiB: 64, cgroupBytes: 2 * GIB })
            expect(description).to.contain('cgroup limit')
            expect(description).to.contain('2048MB')
        })

        it('says host memory when nothing caps the process', function () {
            const { description } = loadWith({ hostGiB: 8 })
            expect(description).to.contain('host memory')
        })
    })

    // The other two figures read their own override, so the third one printing a
    // derived default made the startup line disagree with the argv the child was
    // spawned with, on the one knob the line exists to answer for.
    describe('the startup line states the bulk-sync budget actually spawned', function () {

        it('prints the effective budget the caller injects', function () {
            const { describeInjected } = loadWith({ hostGiB: 64, cgroupBytes: 2 * GIB })
            expect(describeInjected).to.contain('bulk-sync RAM budget 777MB')
            expect(describeInjected).to.not.contain('bulk-sync RAM budget 1024MB')
        })

        it('falls back to the derived budget when no caller value is given', function () {
            const { description } = loadWith({ hostGiB: 64, cgroupBytes: 2 * GIB })
            expect(description).to.contain('bulk-sync RAM budget 1024MB')
        })

        it('leaves the other two figures untouched by the injected value', function () {
            const { description, describeInjected } = loadWith({ hostGiB: 64, cgroupBytes: 2 * GIB })
            const strip = (line) => line.replace(/bulk-sync RAM budget \d+MB/, '')
            expect(strip(describeInjected)).to.equal(strip(description))
        })

        it('is fed the resolved BULK_SYNC_RAM_BUDGET at the startup call site', function () {
            const apiSrc = fs.readFileSync(path.resolve(__dirname, '../../src/api.js'), 'utf8')
            expect(apiSrc, 'the log must state the value the orchestrator is spawned with')
                .to.match(/memoryBudget\.describe\(BULK_SYNC_RAM_BUDGET\)/)
            expect(apiSrc).to.not.match(/memoryBudget\.describe\(\s*\)/)
        })
    })
})
