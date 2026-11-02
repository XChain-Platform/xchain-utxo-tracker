'use strict'

// Parse optional ?limit=&after= pagination params into tracker opts. Throws a
// BAD_REQUEST-coded error on a malformed limit so the route returns HTTP 400.
function parsePageOpts(query, maxPageLimit){
    const opts = {}
    if (query && query.limit != null && query.limit !== '') {
        // Only a number or a plain digit string is a page size (Number() reads true as 1, [7] as 7)
        const n = typeof query.limit === 'number' ? query.limit : (typeof query.limit === 'string' && /^[0-9]+$/.test(query.limit) ? Number(query.limit) : NaN)
        if (!Number.isSafeInteger(n) || n <= 0) {
            const e = new Error('limit must be a positive integer')
            e.code = 'BAD_REQUEST'
            throw e
        }
        opts.limit = Math.min(n, maxPageLimit)
    }
    if (query && query.after != null && query.after !== '') {
        // A cursor only means something on a paged read; without a limit it would be dropped and the full set returned
        if (opts.limit === undefined) {
            const e = new Error('after requires limit')
            e.code = 'BAD_REQUEST'
            throw e
        }
        opts.after = String(query.after)
    }
    return opts
}

module.exports = { parsePageOpts }
