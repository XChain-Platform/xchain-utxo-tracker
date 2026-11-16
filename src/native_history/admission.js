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

// Who may add an address to the history watch list. Watching costs a backfill
// scan and a row per future transaction, so an unauthenticated caller must not be
// able to make the tracker do that for arbitrary addresses for free:
//   - each source IP may add at most `perIp` new addresses per window, keyed on
//     req.ip exactly as the per-IP rate limiter is;
//   - the watch list has a ceiling;
//   - a refused address stays refused for `cooldownMs`, so a wallet polling it does
//     not re-run the checks each time: for every caller when the list was full,
//     and only for the same source IP when that IP's budget ran out, so one
//     over-budget caller cannot lock other wallets out of an address.

// Most IPs and refused addresses remembered at once; the oldest go first.
const TRACKED_MAX = 50000

// Drops the oldest entries of a Map (insertion order) down to the ceiling.
function trim(map){
    while (map.size > TRACKED_MAX) map.delete(map.keys().next().value)
}

class HistoryAdmission {
    constructor({ perIp, windowMs, cooldownMs, now }){
        this.perIp = perIp
        this.windowMs = windowMs
        this.cooldownMs = cooldownMs
        this.now = now
        this.byIp = new Map()
        this.coolingUntil = new Map()
    }

    // Admits one new address for `ip`, or names why not. Charges the IP on admission.
    admit(hex, ip, watchFull){
        const now = this.now()
        const key = String(ip || '')
        if (this.cooling(hex, now) || this.cooling(key + '|' + hex, now)) return 'COOLDOWN'
        let spent = this.byIp.get(key)
        if (!spent || now - spent.since >= this.windowMs) spent = { since: now, count: 0 }
        const refusal = watchFull ? 'WATCH_LIST_FULL' : (spent.count >= this.perIp ? 'IP_BUDGET' : null)
        if (refusal) {
            this.coolingUntil.set(refusal === 'IP_BUDGET' ? key + '|' + hex : hex, now + this.cooldownMs)
            trim(this.coolingUntil)
            return refusal
        }
        spent.count++
        this.byIp.delete(key)
        this.byIp.set(key, spent)
        trim(this.byIp)
        return null
    }

    // True while `coolKey` is cooling down; forgets it once it has cooled.
    cooling(coolKey, now){
        const until = this.coolingUntil.get(coolKey)
        if (until === undefined) return false
        if (until > now) return true
        this.coolingUntil.delete(coolKey)
        return false
    }
}

module.exports = HistoryAdmission
