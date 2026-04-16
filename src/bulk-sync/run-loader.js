'use strict'

// CLI wrapper for loader.js
// Usage: node run-loader.js --keys <dir> --out <db-path> --backend <rocksdb|leveldown>

const { loadKeys } = require('./merger/loader.js')

const args = process.argv.slice(2)
function getArg(name) {
    const idx = args.indexOf(name)
    if (idx === -1 || idx + 1 >= args.length) return null
    return args[idx + 1]
}

const keysDir = getArg('--keys')
const dbPath  = getArg('--out')
const backend = getArg('--backend') || 'rocksdb'

if (!keysDir || !dbPath) {
    console.error('Usage: node run-loader.js --keys <dir> --out <db-path> [--backend rocksdb|leveldown]')
    process.exit(1)
}

loadKeys({
    keysDir,
    dbPath,
    backend,
    onProgress(ev) {
        if (ev.phase === 'prefix-done') {
            console.log(`  ${ev.prefix}: ${ev.count} records (${ev.elapsed_ms}ms)`)
        } else if (ev.phase === 'done') {
            const total = Object.values(ev.stats).reduce((a, b) => a + b, 0)
            console.log(`Done: ${total} records in ${ev.elapsed_ms}ms`)
        }
    }
}).then(res => {
    console.log('Stats:', JSON.stringify(res.stats))
}).catch(err => {
    console.error('FATAL:', err)
    process.exit(1)
})
