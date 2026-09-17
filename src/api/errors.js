'use strict'

const { spawn, spawnSync } = require('child_process')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { createHash, createPublicKey, verify: verifyAsymmetric } = require('crypto')
const { getLogger } = require('../observability')
const {
    isWrapperArchive,
    parseSha256Sidecar,
    hasRequiredLevelDbMembers,
    parseDetachedSignature
} = require('../bootstrap/restore_validation.js')

const logger = getLogger()
let readRestoreOptions = () => ({})

function configureRestoreOptions(reader) {
    readRestoreOptions = reader
}

// Map address-query errors to HTTP status codes. ADDRESS_TOO_LARGE -> 413 (use
// pagination); malformed cursor/limit -> 400; everything else -> 500. Without
// this, an unbounded mega-address query would have OOM-crashed the process.
function sendAddressError(res, err){
    const code = err && err.code
    if (code === 'ADDRESS_TOO_LARGE') {
        res.status(413).json({ error: err.message, code })
    } else if (code === 'INVALID_CURSOR' || code === 'BAD_REQUEST') {
        res.status(400).json({ error: err.message, code })
    } else {
        logger.error('Address query failed: ' + (err && err.stack ? err.stack : err))
        res.status(500).json({ error: (err && err.message) || 'internal error' })
    }
}
function safeBootstrapFilename(filename) {
    // Bootstrap RPC filenames are concatenated into a filesystem path, so they
    // must be a single path component (no directory traversal). Reject anything
    // with a path separator, parent ref, NUL, or that path.basename would alter.
    // Without this, "../../.." escapes /bootstrap/xchain-utxo-tracker/ and reads
    // or writes arbitrary files as root over an unauthenticated RPC.
    if (typeof filename !== 'string' || filename.length === 0 || filename.length > 255) {
        throw new Error('invalid bootstrap filename')
    }
    if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')
        || filename === '.' || filename === '..'
        || filename !== path.basename(filename)) {
        throw new Error('invalid bootstrap filename: path traversal rejected')
    }
    return filename
}

async function getGzipJsonMetadata(filePath) {
    // Extract the embedded JSON metadata line from the file's leading bytes
    // WITHOUT a shell. The previous implementation interpolated `filePath` into
    // a `head | strings | grep` pipeline run via child_process.exec, so a
    // crafted filename (e.g. "$(...)" / backticks) injected shell commands:
    // remote code execution on an unauthenticated bootstrap RPC. This pure-Node
    // version reads a bounded prefix, emulates `strings` (runs of >= 4 printable
    // ASCII bytes, broken by any other byte), and returns the first run that is
    // a parseable JSON object. Contract is unchanged: resolves the metadata
    // object, or null when none is found / the file can't be read.
    const MAX_BYTES = 65 * 1024
    const MIN_RUN = 4

    let buf
    try {
        const fd = await fs.promises.open(filePath, 'r')
        try {
            const out = Buffer.alloc(MAX_BYTES)
            const { bytesRead } = await fd.read(out, 0, MAX_BYTES, 0)
            buf = out.subarray(0, bytesRead)
        } finally {
            await fd.close()
        }
    } catch (err) {
        // Missing/unreadable file: same as "no metadata found".
        return null
    }

    let start = -1
    for (let i = 0; i <= buf.length; i++) {
        const b = i < buf.length ? buf[i] : -1
        const printable = b >= 0x20 && b <= 0x7e
        if (printable) {
            if (start === -1) start = i
            continue
        }
        if (start !== -1) {
            if (i - start >= MIN_RUN
                && buf[start] === 0x7b /* { */
                && buf[i - 1] === 0x7d /* } */) {
                try {
                    return JSON.parse(buf.toString('latin1', start, i))
                } catch (parseError) {
                    // Not valid JSON: keep scanning for the next candidate run.
                }
            }
            start = -1
        }
    }
    return null
}


// List the first `limit` member paths of a (pigz/gzip) tar archive without a full
// extract: tar streams members in order, so we read the head and kill it early.
function listArchiveMembers(source, limit) {
    return new Promise((resolve, reject) => {
        const names = []
        const proc = spawn('tar', ['-tzf', source])
        let done = false
        let buf = ''
        const finish = (err) => {
            if (done) return
            done = true
            try { proc.kill('SIGKILL') } catch (e) { /* already gone */ }
            if (err) reject(err); else resolve(names)
        }
        proc.stdout.on('data', (d) => {
            buf += d.toString()
            let nl
            while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl).trim()
                buf = buf.slice(nl + 1)
                if (line) names.push(line)
                if (names.length >= limit) return finish(null)
            }
        })
        let stderr = ''
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('error', (e) => finish(e))
        proc.on('close', (code) => {
            // A short archive closes before `limit` lines: success. A nonzero exit with
            // no members means tar could not read it as a gzip tar at all.
            if (names.length > 0 || code === 0) return finish(null)
            finish(new Error(`tar could not list "${source}" (exit ${code}): ${stderr.trim()}`))
        })
    })
}

// Streaming sha256 of a file, returned as lowercase hex.
function sha256File(source) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256')
        const rs = fs.createReadStream(source)
        rs.on('error', reject)
        rs.on('data', (chunk) => hash.update(chunk))
        rs.on('end', () => resolve(hash.digest('hex')))
    })
}

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

// Unwrap a BootstrapService two-layer wrapper archive (outer gzip tar whose members
// are `data.tar.gz` + `data.sha256`) into a temp working dir, verify the inner
// payload against its published checksum, and return the inner `data.tar.gz` path as
// the effective source for the rest of the restore pipeline. Throws (aborting with the
// live DB intact, since this runs BEFORE the /data wipe) on any extraction, layout, or
// checksum failure. The caller must remove `tmpDir` when done.
async function unwrapBootstrapArchive(source) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-restore-unwrap-'))
    try {
        const ex = spawnSync('tar', ['-xzf', source, '-C', tmpDir], { encoding: 'utf8' })
        if (ex.status !== 0)
            throw new Error(`Refusing to restore "${source}": failed to extract the wrapper archive `
                + `(tar exit ${ex.status}): ${(ex.stderr || '').trim()}`)

        const innerTarGz = findMemberByBasename(tmpDir, 'data.tar.gz')
        const innerSha   = findMemberByBasename(tmpDir, 'data.sha256')
        if (!innerTarGz || !innerSha)
            throw new Error(`Refusing to restore "${source}": wrapper archive is missing its inner `
                + `data.tar.gz and/or data.sha256 member after extraction.`)

        const expected = parseSha256Sidecar(fs.readFileSync(innerSha, 'utf8'))
        if (!expected)
            throw new Error(`Refusing to restore "${source}": inner data.sha256 has no valid sha256 digest.`)
        const actual = await sha256File(innerTarGz)
        if (actual !== expected)
            throw new Error(`Refusing to restore "${source}": inner data.tar.gz sha256 mismatch `
                + `(expected ${expected}, got ${actual}) - archive is truncated, stale, or tampered.`)
        logger.info(`Wrapper archive unwrapped; inner data.tar.gz sha256 verified against data.sha256`)
        return { effectiveSource: innerTarGz, tmpDir }
    } catch (err) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
        throw err
    }
}

// Detached provenance signature published next to the archive, and the public key
// this repo pins as the trust anchor. Mirrors xchain-node's BootstrapService: the
// anchor travels with the CODE, not with the data server, so an attacker who controls
// the bootstrap host still cannot mint an archive this tracker will restore.
const BOOTSTRAP_SIG_SUFFIX = '.sig'
const DEFAULT_BOOTSTRAP_PUBKEY_PATH = path.join(__dirname, '..', 'config', 'bootstrap_signing_pubkey.pem')

// Load the pinned bootstrap signing public key, or null when none is present.
function loadBootstrapPublicKey() {
    const override = readRestoreOptions().bootstrapPubkey
    const pubkeyPath = override || DEFAULT_BOOTSTRAP_PUBKEY_PATH
    // Swapping the anchor via env silently moves the trust root off the pinned key, so
    // say so as loudly as the unsigned opt-out does; an operator reading "signature OK"
    // must know which key produced it.
    if (override && path.resolve(override) !== path.resolve(DEFAULT_BOOTSTRAP_PUBKEY_PATH))
        logger.warn(`WARNING: bootstrap signature trust anchor overridden via UTXO_TRACKER_BOOTSTRAP_PUBKEY=${override}; `
            + `the repo-pinned public key (${DEFAULT_BOOTSTRAP_PUBKEY_PATH}) is NOT in use.`)
    if (!fs.existsSync(pubkeyPath)) return null
    return createPublicKey(fs.readFileSync(pubkeyPath, 'utf8'))
}

// Provenance gate, run before any checksum work and before the destructive wipe.
// Every checksum this file verifies travels WITH the archive (the sidecar beside it,
// the inner data.sha256 inside it), so anyone who can write the bootstrap volume or
// alter the archive in transit can recompute it and be self-consistent: integrity is
// not authenticity. The published archives carry `<archive>.sig`, an ed25519
// signature over the archive's sha256 digest, which xchain-node's downloadBootstrap
// fetches into the same directory. Fail closed: a missing key or missing/bad signature
// refuses the restore unless the operator sets BOOTSTRAP_RESTORE_ALLOW_UNSIGNED=1,
// which is what a locally-taken getbootstrap snapshot (unsigned, no signing key in the
// container) needs. Returns silently when the archive may be used; throws when it must
// not be.
async function verifyBootstrapProvenanceOrThrow(source) {
    const sigPath   = source + BOOTSTRAP_SIG_SUFFIX
    const publicKey = loadBootstrapPublicKey()

    if (publicKey && fs.existsSync(sigPath)) {
        const signature = parseDetachedSignature(fs.readFileSync(sigPath, 'utf8'))
        if (!signature)
            throw new Error(`Refusing to restore "${source}": signature file ${sigPath} is malformed `
                + `(expected "v1 ed25519 <base64>").`)
        const digestHex = await sha256File(source)
        if (!verifyAsymmetric(null, Buffer.from(digestHex, 'hex'), publicKey, signature))
            throw new Error(`Refusing to restore "${source}": detached signature ${sigPath} does not verify `
                + `against the pinned bootstrap signing key - the archive is not the one that was published.`)
        logger.info(`Restore archive provenance verified: ${sigPath} checks out against the pinned signing key`)
        return
    }

    const missing = !publicKey
        ? `no bootstrap signing public key is pinned (${DEFAULT_BOOTSTRAP_PUBKEY_PATH})`
        : `no signature file found (${sigPath})`
    if (readRestoreOptions().allowUnsigned !== '1')
        throw new Error(`Refusing to restore "${source}": ${missing}, so the archive's PROVENANCE cannot be `
            + `checked before the destructive /data wipe (its checksums ship with it and prove only that it is `
            + `internally consistent). Publish a .sig next to the archive, or set `
            + `BOOTSTRAP_RESTORE_ALLOW_UNSIGNED=1 to restore an unsigned archive at your own risk.`)
    logger.warn(`WARNING: restoring "${source}" WITHOUT provenance verification (${missing}) because `
        + `BOOTSTRAP_RESTORE_ALLOW_UNSIGNED=1 is set; the checksum only detects transport corruption, not tampering.`)
}

// Content gate: refuse an archive that is not a LevelDB store at all. Checksums and
// signatures both say "this is the archive that was published"; neither says "this
// archive holds a store", so without this gate a correctly-signed-or-checksummed
// tar of unrelated files passes validation, the unconditional wipe deletes /data, and
// the tracker reopens onto a fresh empty DB. The member list must be the FULL one:
// the limit-10 listing used for wrapper detection is far too short, since CURRENT and
// MANIFEST-* sort after the first ten members of a real store. Cost is one extra
// decompress pass of an archive the pipeline is about to decompress anyway.
async function assertLevelDbArchiveOrThrow(archivePath, reportedSource) {
    const members = await listArchiveMembers(archivePath, Infinity)
    if (!hasRequiredLevelDbMembers(members))
        throw new Error(`Refusing to restore "${reportedSource}": the archive does not contain a LevelDB store `
            + `(no CURRENT plus MANIFEST-* member), so extracting it over the wiped /data would leave the `
            + `tracker on an empty database.`)
}

// Post-extraction ground truth: the store must be AT the database root, because that
// is the only place ClassicLevel("/data/<DB_NAME>") will look for it. The pre-wipe
// member gate can only predict the layout from the tar listing, and `tar -x -C <root>`
// preserves whatever directories the archive carries, so an archive whose store sits
// one level down (the publisher tars the whole tracker volume, yielding
// `./xchain-utxo-tracker/CURRENT`) satisfies that gate and still leaves nothing at the
// root. Throwing here routes the restore into handleRestoreFailure's fail-loud branch:
// the DB is already gone either way, so the choice is between an operator who knows
// the restore failed and a tracker that quietly serves an empty database.
function assertExtractedStoreOrThrow(destination) {
    let entries = []
    try { entries = fs.readdirSync(destination) }
    catch (err) {
        throw new Error(`Restore extracted to "${destination}" but that directory cannot be read `
            + `(${err && err.message}); the database was wiped and must be resynced.`)
    }
    const hasCurrent  = entries.includes('CURRENT')
    const hasManifest = entries.some(name => /^MANIFEST-\d+$/.test(name))
    if (hasCurrent && hasManifest) return
    const nested = entries.filter(name => {
        try { return fs.statSync(path.join(destination, name)).isDirectory() } catch (e) { return false }
    })
    throw new Error(`Restore extracted successfully but left no LevelDB store at "${destination}" `
        + `(CURRENT=${hasCurrent}, MANIFEST-<n>=${hasManifest})`
        + (nested.length ? `; the archive nests its store under ${nested.map(n => `"${n}"`).join(', ')}, `
            + `which must be repacked from inside the store directory (tar -cf - -C <store> .)` : '')
        + `. The database was wiped by the restore and must be resynced.`)
}

// Validate a restore archive BEFORE the destructive /data wipe. Returns the effective
// source to feed the pigz/tar pipeline plus an optional temp dir the caller must clean
// up. Three gates, in trust order: provenance (a detached signature over the outer
// archive, fail-closed unless BOOTSTRAP_RESTORE_ALLOW_UNSIGNED=1), integrity
// (the BootstrapService wrapper layout is unwrapped and its inner payload
// checksum-verified in place rather than refused; a single-layer archive
// is verified against its published sha256 sidecar, with a missing sidecar
// failing closed unless BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED=1), and content (the
// effective archive really is a LevelDB store).
async function validateBootstrapArchiveOrThrow(source) {
    await verifyBootstrapProvenanceOrThrow(source)

    const members = await listArchiveMembers(source, 10)
    if (isWrapperArchive(members)) {
        const unwrapped = await unwrapBootstrapArchive(source)
        try {
            await assertLevelDbArchiveOrThrow(unwrapped.effectiveSource, source)
        } catch (err) {
            // unwrapBootstrapArchive hands the temp dir to the caller once it returns, so
            // a rejection here owns the cleanup it would otherwise have done itself.
            try { fs.rmSync(unwrapped.tmpDir, { recursive: true, force: true }) } catch (_) {}
            throw err
        }
        return unwrapped
    }

    const sidecarPath = source + '.sha256'
    if (fs.existsSync(sidecarPath)) {
        const expected = parseSha256Sidecar(fs.readFileSync(sidecarPath, 'utf8'))
        if (!expected)
            throw new Error(`Refusing to restore "${source}": checksum sidecar ${sidecarPath} has no valid sha256 digest.`)
        const actual = await sha256File(source)
        if (actual !== expected)
            throw new Error(`Refusing to restore "${source}": sha256 mismatch vs ${sidecarPath} `
                + `(expected ${expected}, got ${actual}) - archive is truncated, stale, or tampered.`)
        logger.info(`Restore archive sha256 verified against ${sidecarPath}`)
    } else if (readRestoreOptions().allowUnverified === '1') {
        logger.warn(`WARNING: no checksum sidecar at ${sidecarPath}; restoring "${source}" UNVERIFIED `
            + `(truncation/tampering cannot be detected) because BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED=1 is set. `
            + `Publish a .sha256 next to the archive to restore integrity checking.`)
    } else {
        throw new Error(`Refusing to restore "${source}": no checksum sidecar at ${sidecarPath}, so the `
            + `archive cannot be verified against truncation or tampering before the destructive /data wipe. `
            + `Publish a .sha256 next to the archive, or set BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED=1 to proceed `
            + `unverified at your own risk.`)
    }
    await assertLevelDbArchiveOrThrow(source, source)
    return { effectiveSource: source, tmpDir: null }
}

module.exports = { configureRestoreOptions, sendAddressError, safeBootstrapFilename, getGzipJsonMetadata, listArchiveMembers, sha256File, unwrapBootstrapArchive, verifyBootstrapProvenanceOrThrow, assertLevelDbArchiveOrThrow, assertExtractedStoreOrThrow, validateBootstrapArchiveOrThrow }
