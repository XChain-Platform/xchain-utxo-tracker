'use strict'

const fs = require('fs')
const path = require('path')
const { getLogger } = require('../../observability')
const {
    BOOTSTRAP_META_MEMBER,
    parseArchiveMeta,
    compareArchiveIdentity
} = require('../../bootstrap/restore_validation.js')

const logger = getLogger()

// Locate a member by basename inside an already-extracted directory tree.
function findMemberByBasename(rootDir, wantBase) {
    const stack = [rootDir]
    while (stack.length) {
        const dir = stack.pop()
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name)
            if (ent.isDirectory()) { stack.push(full); continue }
            if (ent.name === wantBase) return full
        }
    }
    return null
}

// A metadata member bigger than this is not metadata (xchain-node's reader uses the same bound).
const BOOTSTRAP_META_MAX_BYTES = 64 * 1024

// Read the unwrapped bootstrap.json by basename wherever it sits (leading the wrapper only speeds
// xchain-node's read), or null when absent, oversized, unreadable or not format 1 (a legacy archive).
function readUnwrappedArchiveMeta(tmpDir) {
    const metaPath = findMemberByBasename(tmpDir, BOOTSTRAP_META_MEMBER)
    try {
        return (metaPath && fs.statSync(metaPath).size <= BOOTSTRAP_META_MAX_BYTES)
            ? parseArchiveMeta(fs.readFileSync(metaPath, 'utf8')) : null
    } catch (_) { return null }
}

// Identity gate, after provenance (so the metadata is authenticated) and before the wipe:
// refuse a wrapper whose bootstrap.json names another module, coin or network, or a real
// signed archive for another combo passes every gate and installs a foreign chain's store.
function assertArchiveIdentityOrThrow(tmpDir, source, target) {
    const identity = compareArchiveIdentity(readUnwrappedArchiveMeta(tmpDir), target)
    const label = (id) => `${id.module || '?'} ${id.coin || '?'}/${id.network || '?'}`
    if (identity.status === 'mismatch') {
        const found = identity.mismatches.map(m => `${m.field} "${m.archive}"`).join(', ')
        const missingTarget = identity.mismatches.some(m => m.target === null)
        throw new Error(`Refusing to restore "${source}": its bootstrap.json declares ${found}, but this `
            + `tracker is ${label(target)}. The archive belongs to another tracker; nothing was wiped.`
            + (missingTarget ? ' Configure NETWORK as <coin>-<network> so the restore target names both fields.' : ''))
    }
    // An archive that does not name a field cannot be compared on it: say so, then restore as before.
    if (identity.status === 'unchecked')
        logger.warn(`Bootstrap archive identity not checked for ${identity.unchecked.join('/')} `
            + `(archive does not declare it); restore target is ${label(target)}.`)
    else logger.info(`Restore archive identity matches this tracker (${label(target)})`)
}

module.exports = { findMemberByBasename, assertArchiveIdentityOrThrow }
