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
 **********************************************************************/

'use strict'

// Staged restore. A restore archive is extracted into a directory inside the
// database root, its store layout is read, and only a store this tracker can
// open replaces the live one. The layout stamp is a key inside the LevelDB
// files, so it cannot be read from the tar listing: the archive has to be
// extracted and opened first. The staging directory sits inside the root (not
// beside it) because the root can itself be a mount point, and a rename out of
// a mount point's parent crosses filesystems. A restore therefore needs room
// for the live store and the staged copy at the same time.

const fs = require('fs')
const path = require('path')
const { ClassicLevel } = require('classic-level')
const { getLayoutVersion } = require('../store/level_up_db/store_layout')
const { STORE_LAYOUT_VERSION, PREFIX_LAST_BLOCK_HEIGHT } = require('../store/level_up_db/constants')

const STAGING_DIR_NAME = '.restore-staging'

function describeLayout(version) {
    if (version === null) return 'no data'
    return Number.isNaN(version) ? 'an unreadable layout stamp' : `layout ${version}`
}

// Fresh, empty staging directory inside `destination`; a leftover from an
// interrupted restore is discarded first.
function prepareStagingDir(destination) {
    const staging = path.join(destination, STAGING_DIR_NAME)
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    return staging
}

function discardStagingDir(destination) {
    fs.rmSync(path.join(destination, STAGING_DIR_NAME), { recursive: true, force: true })
}

// Opens the extracted store with the layout gate's own reader and refuses
// anything but the layout this tracker reads. The store is closed before
// returning so its files can be moved.
async function assertStagedLayoutOrThrow(stagingDir) {
    const db = new ClassicLevel(stagingDir, { createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer' })
    let version, height = null
    try {
        await db.open()
        version = await getLayoutVersion.call({ db })
        const storedHeight = await db.get(PREFIX_LAST_BLOCK_HEIGHT)
        if (storedHeight !== undefined) {
            const parsed = parseInt(storedHeight.toString(), 16)
            if (Number.isInteger(parsed) && parsed >= 0) height = parsed
        }
    } catch (err) {
        throw new Error(`Refusing to restore: the extracted archive could not be opened as a LevelDB store `
            + `(${err && err.message}). The live database was left untouched.`, { cause: err })
    } finally {
        try { await db.close() } catch (_) {}
    }
    if (version === STORE_LAYOUT_VERSION) return height
    throw new Error(`Refusing to restore: the archive holds a store with ${describeLayout(version)} but this tracker `
        + `reads layout ${STORE_LAYOUT_VERSION}. The live database was left untouched.`)
}

// Moves the verified store's files up into `destination`, which the caller has
// already emptied of everything but the staging directory. An archive cut from a
// data directory that still held an interrupted restore's staging directory
// carries that name at its root; it is not part of the store, and renaming it
// onto the staging directory itself would fail once the live store is gone, so
// it is dropped instead of moved.
function promoteStagedStore(destination) {
    const staging = path.join(destination, STAGING_DIR_NAME)
    for (const name of fs.readdirSync(staging)) {
        if (name === STAGING_DIR_NAME) continue
        fs.renameSync(path.join(staging, name), path.join(destination, name))
    }
    fs.rmSync(path.join(staging, STAGING_DIR_NAME), { recursive: true, force: true })
    fs.rmdirSync(staging)
}

module.exports = {
    STAGING_DIR_NAME,
    prepareStagingDir,
    discardStagingDir,
    assertStagedLayoutOrThrow,
    promoteStagedStore
}
