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
 * Rate-limit refusal counter/logger
 *
 * With only a `message` option, express-rate-limit sends its 429 and logs
 * nothing, so a caller knocked over by the per-IP limiter (an encoder whose
 * readiness reads share the bucket, say) left no trace in the tracker log.
 *
 * express-rate-limit sets the draft-6 RateLimit-* and Retry-After headers
 * and picks the status/body before calling a custom `handler`, so `message`
 * moves here and the handler sends it itself. A line per refusal would
 * flood the log under real abuse, so this logs once at the first refusal
 * of a window and again at the first refusal after a full windowMs has
 * elapsed since that line, carrying how many refusals happened since. The
 * count only advances on an actual refusal (no timer/interval), so an idle
 * limiter never holds the process open. With no timer the span a line covers
 * has no upper bound, so each line states the seconds since the previous one.
 *
 * Same shape as the encoder's src/server/rate_limit_log.js, so the refusal
 * lines read alike across services.
 *
 ********************************************************************/

'use strict'

function limitedHandler({ service, name, envVar, limit, windowMs, message, log = console.warn, now = Date.now }) {
    const windowSeconds = Math.round(windowMs / 1000)
    let count = 0
    let lastLogAt = null

    return function (req, res, next, options) {
        res.status(429).json(message)

        count++
        const ts = now()
        const dueForLog = lastLogAt === null || (ts - lastLogAt >= windowMs)
        if (dueForLog) {
            const n = count
            const spanSeconds = lastLogAt === null ? windowSeconds : Math.round((ts - lastLogAt) / 1000)
            log(`${service} rate limit [${name}]: ${n} request${n === 1 ? '' : 's'} refused in the last ${spanSeconds} s (limit ${limit}/${windowSeconds} s); raise ${envVar} if this is legitimate traffic`)
            count = 0
            lastLogAt = ts
        }
    }
}

module.exports = { limitedHandler }
