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

// Store layout version gate. A store carries its key layout version under the
// LAYOUT_VERSION metadata key. Layout 2 keys every txid field on the whole
// 32-byte txid; a store with no stamp (and any data) is layout 1, whose txid
// fields are 8-byte prefixes. Layout 1 keys cannot be read by layout 2 code and
// cannot be converted in place (the 8-byte prefixes do not hold the full txid),
// so startup refuses it until the operator rebuilds or resets the store.

const { PREFIX_LAYOUT_VERSION, STORE_LAYOUT_VERSION, PREFIX_LAST_BLOCK_HEIGHT } = require('./constants')

const LEGACY_LAYOUT_VERSION = 1

module.exports = {
    // The stamped layout version, LEGACY_LAYOUT_VERSION for a store with data
    // but no stamp, or null for an empty store. A stamp that is not a positive
    // integer reads as NaN so the gate refuses it rather than guessing.
    async getLayoutVersion(){
        const raw = await this.db.get(PREFIX_LAYOUT_VERSION)
        if (raw !== undefined) {
            const text = raw.toString()
            return /^[1-9][0-9]*$/.test(text) ? Number(text) : NaN
        }
        for await (const key of this.db.keys({ limit: 1 })) {
            if (key !== undefined) return LEGACY_LAYOUT_VERSION
        }
        return null
    },

    async setLayoutVersion(version = STORE_LAYOUT_VERSION){
        await this.db.put(PREFIX_LAYOUT_VERSION, Buffer.from(String(version)))
    },

    // Run at open, before anything reads the store. A fresh store is stamped
    // unless `stamp` is false for the bulk-sync loader. Every non-empty store
    // whose stamp is absent, invalid or different is left byte-for-byte intact
    // and refused with rebuild instructions.
    async ensureLayoutVersion({ stamp = true } = {}){
        const version = await this.getLayoutVersion()
        if (version === STORE_LAYOUT_VERSION) return 'current'
        if (version === null) {
            if (stamp) await this.setLayoutVersion()
            return 'empty'
        }
        if (Number.isNaN(version)) {
            const raw = (await this.db.get(PREFIX_LAYOUT_VERSION)).toString()
            throw new Error("Store '" + this.dbName + "' has an unreadable layout stamp " + JSON.stringify(raw)
                + "; this tracker requires layout " + STORE_LAYOUT_VERSION + ". Refusing to start. Rebuild the store"
                + " with bulk sync, or reset it for a full rescan.")
        }
        if (!(version < STORE_LAYOUT_VERSION)) {
            throw new Error("Store '" + this.dbName + "' has layout version " + version + " but this tracker reads layout "
                + STORE_LAYOUT_VERSION + ". Refusing to start. Run a tracker release that reads layout " + version
                + ", rebuild the store with bulk sync, or reset it for a full rescan.")
        }
        const heightRaw = await this.db.get(PREFIX_LAST_BLOCK_HEIGHT)
        const height = heightRaw === undefined ? -1 : parseInt(heightRaw.toString(), 16)
        // An unstamped store with data but no tip is a bulk load that stopped
        // before its final batch (the loader writes the stamp with the tip), of
        // either format; only a store with a tip and no stamp is known layout 1.
        const why = height < 0
            ? "has data but no layout stamp and no tip, which a bulk load that stopped before its final batch leaves"
            : "has layout " + version + " (8-byte txid prefixes in its keys, indexed to block " + height + ")"
        throw new Error("Store '" + this.dbName + "' " + why + "; this tracker requires layout "
            + STORE_LAYOUT_VERSION + " with full 32-byte txids. Refusing to start without reading or changing the"
            + " old keys. Rebuild the store with bulk sync, or reset it for a full rescan.")
    },
}
