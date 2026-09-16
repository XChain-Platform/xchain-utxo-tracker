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

/**
 * XChain UTXO Tracker - Bulk Sync resume artifact validation
 *
 * The orchestrator's resume gates originally keyed on existence (concat) or
 * byte size (sorted intermediates). Both leave a stale-artifact window: a
 * merge dir reused across runs can hold an `all-*.dat` or `*-sorted.dat`
 * from a DIFFERENT range/network (or an aborted earlier run) that happens to
 * satisfy the gate, and the pipeline then silently seeds a DB from the wrong
 * data. Two closures, matched to what each artifact can prove about itself:
 *
 *  - Concat artifacts (`all-*.dat`) are self-describing: their 64B header
 *    carries magic/chain/net/firstHeight/lastHeight/recordCount/recordSize.
 *    `validateConcatArtifact` re-derives identity from the header and checks
 *    it against the run's requested {chain, net, from, to} plus internal
 *    size/count consistency. No sidecar needed.
 *
 *  - Sorted intermediates are headerless (externalSort strips the header),
 *    so they get a JSON sidecar manifest (`<artifact>.manifest.json`)
 *    written tmp -> fsync -> rename AFTER the sort completes, binding the
 *    artifact to the source header it was sorted from. A resume may reuse a
 *    sorted file only when the manifest exists and matches both the current
 *    source header and the artifact's on-disk size.
 *
 * Reuse denial is advisory (the caller rebuilds); corrupt inputs that cannot
 * be rebuilt fail loud downstream (concat throws on zero inputs).
 */

const fs = require('fs')

const { HEADER_SIZE, MAGIC_OUTPUTS, MAGIC_SPENDS, MAGIC_META, CHAIN_CODES, NETWORK_CODES } = require('../writers.js')

const KNOWN_MAGICS = [MAGIC_OUTPUTS, MAGIC_SPENDS, MAGIC_META].map(m => m.toString('ascii'))

// Read and decode a bulk-sync .dat header (layout: writers.writeHeader).
function parseDatHeader(filePath) {
    const fd = fs.openSync(filePath, 'r')
    try {
        const buf = Buffer.alloc(HEADER_SIZE)
        let read = 0
        while (read < HEADER_SIZE) {
            const n = fs.readSync(fd, buf, read, HEADER_SIZE - read, read)
            if (n === 0) throw new Error(`${filePath}: short header read (${read} of ${HEADER_SIZE} bytes)`)
            read += n
        }
        return {
            magic:       buf.toString('ascii', 0, 8),
            chain:       buf.readUInt8(8),
            net:         buf.readUInt8(9),
            version:     buf.readUInt16LE(10),
            firstHeight: buf.readUInt32LE(12),
            lastHeight:  buf.readUInt32LE(16),
            recordCount: buf.readBigUInt64LE(20),
            recordSize:  buf.readUInt32LE(28),
            fileSize:    fs.fstatSync(fd).size,
        }
    } finally {
        fs.closeSync(fd)
    }
}

// Split an orchestrator network string ('bitcoin-regtest') into header codes.
function networkToCodes(network) {
    const idx = String(network).indexOf('-')
    const chainName = idx === -1 ? String(network) : network.slice(0, idx)
    const netName   = idx === -1 ? '' : network.slice(idx + 1)
    if (!(chainName in CHAIN_CODES))  throw new Error(`Unknown chain in network '${network}'`)
    if (!(netName in NETWORK_CODES))  throw new Error(`Unknown net in network '${network}'`)
    return { chain: CHAIN_CODES[chainName], net: NETWORK_CODES[netName] }
}

/**
 * Decide whether an existing concat artifact belongs to THIS run.
 * expected: { chain, net, from, to } - `to` may be null (tip mode: the run's
 * end height was resolved dynamically, so only the start is checkable).
 * Returns { ok: true, header } or { ok: false, reason }.
 */
function validateConcatArtifact(filePath, expected) {
    let header
    try {
        header = parseDatHeader(filePath)
    } catch (e) {
        return { ok: false, reason: e.message }
    }
    if (!KNOWN_MAGICS.includes(header.magic)) {
        return { ok: false, reason: `${filePath}: unknown magic '${header.magic}'` }
    }
    if (header.chain !== expected.chain || header.net !== expected.net) {
        return { ok: false, reason: `${filePath}: header chain/net ${header.chain}/${header.net} != requested ${expected.chain}/${expected.net}` }
    }
    if (expected.from !== null && expected.from !== undefined && header.firstHeight !== expected.from) {
        return { ok: false, reason: `${filePath}: header firstHeight ${header.firstHeight} != requested --from ${expected.from}` }
    }
    if (expected.to !== null && expected.to !== undefined && header.lastHeight !== expected.to) {
        return { ok: false, reason: `${filePath}: header lastHeight ${header.lastHeight} != requested --to ${expected.to}` }
    }
    // Internal consistency: the body must be exactly recordCount records wide.
    // (recordSize 0 would be a pre-record_size legacy dump; those never went
    // through the concat path that patches these headers, so treat as stale.)
    if (header.recordSize === 0) {
        return { ok: false, reason: `${filePath}: header recordSize 0 (legacy/foreign artifact)` }
    }
    const body = header.fileSize - HEADER_SIZE
    if (body < 0 || BigInt(body) !== header.recordCount * BigInt(header.recordSize)) {
        return { ok: false, reason: `${filePath}: body ${body}B != recordCount ${header.recordCount} x recordSize ${header.recordSize}` }
    }
    return { ok: true, header }
}

function manifestPath(artifactPath) {
    return artifactPath + '.manifest.json'
}

// Fields of a source header a sorted artifact is bound to.
function manifestFieldsFromHeader(header) {
    return {
        magic:       header.magic,
        chain:       header.chain,
        net:         header.net,
        firstHeight: header.firstHeight,
        lastHeight:  header.lastHeight,
        recordCount: header.recordCount.toString(),
        recordSize:  header.recordSize,
    }
}

/**
 * Bind a finished sorted artifact to the source header it was produced from.
 * Written tmp -> fsync -> rename so a crash mid-write can never leave a
 * manifest that blesses a partial artifact.
 */
function writeSortedManifest(artifactPath, sourceHeader) {
    const meta = {
        ...manifestFieldsFromHeader(sourceHeader),
        sortedSize: fs.statSync(artifactPath).size,
    }
    const finalPath = manifestPath(artifactPath)
    const tmpPath = finalPath + '.tmp'
    const fd = fs.openSync(tmpPath, 'w')
    try {
        fs.writeSync(fd, JSON.stringify(meta, null, 2) + '\n')
        fs.fsyncSync(fd)
    } finally {
        fs.closeSync(fd)
    }
    fs.renameSync(tmpPath, finalPath)
}

/**
 * Decide whether an existing sorted artifact may be reused for this run.
 * Requires: manifest present and parseable, every bound field equal to the
 * CURRENT source header, and the artifact's on-disk size equal to the
 * recorded sortedSize. Returns { ok: true } or { ok: false, reason }.
 */
function checkSortedManifest(artifactPath, sourceHeader) {
    const mPath = manifestPath(artifactPath)
    if (!fs.existsSync(mPath)) {
        return { ok: false, reason: `${artifactPath}: no resume manifest (pre-manifest artifact or foreign file)` }
    }
    let meta
    try {
        meta = JSON.parse(fs.readFileSync(mPath, 'utf8'))
    } catch (e) {
        return { ok: false, reason: `${mPath}: unreadable manifest (${e.message})` }
    }
    const expected = manifestFieldsFromHeader(sourceHeader)
    for (const k of Object.keys(expected)) {
        if (meta[k] !== expected[k]) {
            return { ok: false, reason: `${artifactPath}: manifest ${k}=${meta[k]} != source header ${expected[k]}` }
        }
    }
    const size = fs.existsSync(artifactPath) ? fs.statSync(artifactPath).size : -1
    if (size !== meta.sortedSize) {
        return { ok: false, reason: `${artifactPath}: size ${size}B != manifest sortedSize ${meta.sortedSize}B` }
    }
    return { ok: true }
}

module.exports = {
    parseDatHeader,
    networkToCodes,
    validateConcatArtifact,
    writeSortedManifest,
    checkSortedManifest,
    manifestPath,
}
