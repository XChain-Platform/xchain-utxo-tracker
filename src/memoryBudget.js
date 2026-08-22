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
 * Both used to be fixed constants sized for a large server (4 GiB of
 * block cache under a 4 GB heap ceiling). On a small host that is a
 * multiple of the whole machine: a Raspberry Pi 4 running a testnet
 * backfill reached 4.39 GB RSS and exhausted swap. Capping the
 * container without resizing these is worse, not better, because the
 * process then dies against the cgroup limit instead of the host's,
 * in a restart loop that makes no forward progress.
 *
 * So derive both from the memory this process may actually use, and
 * read that from the cgroup when one applies: inside a container
 * os.totalmem() reports the HOST's memory, so `--memory 2g` is
 * invisible to it and every derived size would be wrong in the one
 * case where being wrong is fatal.
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

// Fractions of the budget. The cache is the larger share because it is a
// steady-state working-set cache, while the heap figure is a flush trigger
// that only has to hold one batch of staged writes. Together they leave
// better than half the budget for the rest of the process and for the
// allocation spikes inside a single block parse.
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

function parseEnvInt(name) {
    const raw = process.env[name]
    if (raw === undefined || raw === '') return null
    const value = parseInt(raw, 10)
    if (!Number.isFinite(value) || value <= 0) return null
    return value
}

// An explicit env value always wins: an operator who has measured their own
// workload knows something this derivation cannot.
function leveldbCacheBytes() {
    const override = parseEnvInt('LEVELDB_CACHE_BYTES')
    if (override !== null) return override
    return Math.floor(clamp(budgetBytes() / CACHE_FRACTION, CACHE_MIN_BYTES, CACHE_MAX_BYTES))
}

function heapFlushThresholdMB() {
    const override = parseEnvInt('HEAP_FLUSH_THRESHOLD_MB')
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
