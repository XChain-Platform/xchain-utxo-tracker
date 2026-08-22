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
 * XChain UTXO Tracker - Memory budget
 *
 * Sizes the two allocations that dominate tracker RSS during a chain
 * backfill: the LevelDB block cache (native, off-heap) and the heap
 * threshold that forces an early batch flush.
 *
 * Both are derived from the memory this process may actually use, which
 * is read from the cgroup whenever one binds below host RAM. That case
 * is the one that must not be got wrong: inside a container
 * os.totalmem() reports the HOST, so a memory-capped tracker would
 * otherwise size itself for the machine and be OOM-killed in a restart
 * loop that never completes a batch. A container cap alone is therefore
 * not a fix; the sizes have to move with it.
 *
 ********************************************************************/

const os = require('os')
const fs = require('fs')

const MIB = 1024 * 1024

// Cache and flush ceilings keep an already-tuned big-server deployment on
// exactly the numbers it runs today: any host at or above 16 GB derives the
// former hardcoded constants, so this only ever loosens on small hosts.
const CACHE_MIN_BYTES = 128 * MIB
const CACHE_MAX_BYTES = 4096 * MIB
const HEAP_FLUSH_MIN_MB = 256
const HEAP_FLUSH_MAX_MB = 2048

// The cache takes the larger share as a steady-state working set; the heap
// figure only has to hold one staged batch. Together they leave better than
// half the budget for the rest of the process and per-block spikes.
const CACHE_FRACTION = 4
const HEAP_FLUSH_FRACTION = 8

// cgroup v2 exposes "max" for unlimited; v1 uses a sentinel near 2^63. Either
// way a limit at or above host RAM tells us nothing the host total does not.
function readCgroupLimitBytes() {
    const candidates = [
        '/sys/fs/cgroup/memory.max',                   // cgroup v2
        '/sys/fs/cgroup/memory/memory.limit_in_bytes'  // cgroup v1
    ]
    for (const path of candidates) {
        let raw
        try {
            raw = fs.readFileSync(path, 'utf8').trim()
        } catch { continue }
        if (raw === 'max' || raw === '') continue
        const value = Number(raw)
        if (!Number.isFinite(value) || value <= 0) continue
        return value
    }
    return null
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value))
}

// Bytes this process should treat as its own, host RAM or the cgroup limit,
// whichever actually binds.
function budgetBytes() {
    const hostBytes = os.totalmem()
    const cgroupBytes = readCgroupLimitBytes()
    if (cgroupBytes !== null && cgroupBytes < hostBytes) return cgroupBytes
    return hostBytes
}

// Takes the value, not the variable name: a computed process.env[name] read is
// invisible to the env-var documentation gate, so every variable is read by
// name at its call site instead.
function parseEnvInt(raw) {
    if (raw === undefined || raw === '') return null
    const value = parseInt(raw, 10)
    if (!Number.isFinite(value) || value <= 0) return null
    return value
}

// An explicit env value always wins: an operator who has measured their own
// workload knows something this derivation cannot.
function leveldbCacheBytes() {
    const override = parseEnvInt(process.env.LEVELDB_CACHE_BYTES)
    if (override !== null) return override
    return Math.floor(clamp(budgetBytes() / CACHE_FRACTION, CACHE_MIN_BYTES, CACHE_MAX_BYTES))
}

function heapFlushThresholdMB() {
    const override = parseEnvInt(process.env.HEAP_FLUSH_THRESHOLD_MB)
    if (override !== null) return override
    const derivedMB = budgetBytes() / HEAP_FLUSH_FRACTION / MIB
    return Math.floor(clamp(derivedMB, HEAP_FLUSH_MIN_MB, HEAP_FLUSH_MAX_MB))
}

// Logged once at startup: when a tracker is killed for memory, the first
// question is what it thought it was allowed to use, and on a capped
// container that answer is not something an operator can infer from the host.
function describe() {
    const cgroupBytes = readCgroupLimitBytes()
    const hostBytes = os.totalmem()
    const bound = (cgroupBytes !== null && cgroupBytes < hostBytes) ? 'cgroup limit' : 'host memory'
    const mb = (bytes) => Math.round(bytes / MIB)
    return `memory budget ${mb(budgetBytes())}MB (${bound}); ` +
        `LevelDB block cache ${mb(leveldbCacheBytes())}MB, heap-flush threshold ${heapFlushThresholdMB()}MB`
}

module.exports = {
    budgetBytes,
    leveldbCacheBytes,
    heapFlushThresholdMB,
    describe
}
