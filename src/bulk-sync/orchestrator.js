'use strict'

/*********************************************************************
 *
 * XChain UTXO Tracker - Bulk Sync Orchestrator
 *
 * Chains the full pipeline: dump → parse → merge → load.
 *
 * Usage:
 *   node orchestrator.js --network bitcoin-regtest --out /tmp/bulk-sync \
 *       --db /tmp/candidate-db --backend rocksdb [options]
 *
 * Requires NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD env vars
 * (passed through to dump.js).
 *
 ********************************************************************/

const fs             = require('fs')
const path           = require('path')
const { fork }       = require('child_process')
const { externalSort }  = require('./merger/external-sort.js')
const { leftAntiJoin }  = require('./merger/streaming-join.js')
const { deriveKeys }    = require('./merger/derive-keys.js')
const { loadKeys }      = require('./merger/loader.js')
const { HEADER_SIZE, OUTPUTS_RECORD_SIZE, SPENDS_RECORD_SIZE } = require('./writers.js')

// --------------- constants ---------------

const OUTPUTS_KEY_SIZE = 12   // txHash8(8) + vout(4)
const SPENDS_KEY_SIZE  = 12   // prevTxHash8(8) + prevVout(4)

const BULK_SYNC_DIR = __dirname

// --------------- arg parsing ---------------

function parseArgs(argv) {
    const args = {
        network:    null,
        from:       0,
        to:         null,      // null = use tip - tipSafety
        tipSafety:  10,
        chunkSize:  10000,
        out:        null,      // working directory for all artifacts
        db:         null,      // final DB path
        backend:    'rocksdb',
        workers:    null,      // null = auto (number of dump chunks)
        ramBudget:  1024,      // MB for external sort
        batchSize:  10000,     // loader batch size
        skipDump:   false,
        skipParse:  false,
    }
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i]
        switch (arg) {
            case '--network':    args.network   = argv[++i]; break
            case '--from':       args.from      = parseInt(argv[++i], 10); break
            case '--to':         args.to        = parseInt(argv[++i], 10); break
            case '--tip-safety': args.tipSafety = parseInt(argv[++i], 10); break
            case '--chunk-size': args.chunkSize = parseInt(argv[++i], 10); break
            case '--out':        args.out       = argv[++i]; break
            case '--db':         args.db        = argv[++i]; break
            case '--backend':    args.backend   = argv[++i]; break
            case '--workers':    args.workers   = parseInt(argv[++i], 10); break
            case '--ram-budget': args.ramBudget = parseInt(argv[++i], 10); break
            case '--batch-size': args.batchSize = parseInt(argv[++i], 10); break
            case '--skip-dump':  args.skipDump  = true; break
            case '--skip-parse': args.skipParse = true; break
            default:
                if (arg === '--help' || arg === '-h') {
                    printUsage()
                    process.exit(0)
                }
                throw new Error(`unknown arg: ${arg}`)
        }
    }
    if (!args.network) throw new Error('--network is required')
    if (!args.out)     throw new Error('--out is required')
    if (!args.db)      throw new Error('--db is required')
    return args
}

function printUsage() {
    console.log(`
Usage: node orchestrator.js [options]

Required:
  --network <name>      e.g. bitcoin-regtest, bitcoin-mainnet
  --out <dir>           working directory for all artifacts
  --db <path>           final DB directory

Options:
  --from <height>       first block (default 0)
  --to <height>         last block (default: tip - tip-safety)
  --tip-safety <n>      blocks before tip to stop (default 10)
  --chunk-size <n>      blocks per .xdmp file (default 10000)
  --backend <name>      rocksdb | leveldown (default rocksdb)
  --workers <n>         parallel parse workers (default: number of chunks)
  --ram-budget <MB>     RAM for external sort (default 1024)
  --batch-size <n>      loader batch size (default 10000)
  --skip-dump           skip dump phase (reuse existing .xdmp files)
  --skip-parse          skip dump+parse phases (reuse existing .dat files)

Environment:
  NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD — coin node RPC
`)
}

// --------------- helpers ---------------

function fmtDuration(ms) {
    const s = Math.floor(ms / 1000)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return `${String(h).padStart(2, '0')}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`
}

function log(phase, msg) {
    const ts = new Date().toISOString().slice(11, 19)
    console.log(`[${ts}] [${phase}] ${msg}`)
}

/**
 * Spawn a child process (fork) and return a promise that resolves on exit 0.
 */
function runChild(scriptPath, args, env) {
    return new Promise((resolve, reject) => {
        const child = fork(scriptPath, args, {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            env: { ...process.env, ...env },
        })
        child.on('exit', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`${path.basename(scriptPath)} exited with code ${code}`))
        })
        child.on('error', reject)
    })
}

/**
 * Concatenate multiple binary files into one, keeping the header from the
 * first file and stripping it from subsequent files. Downstream readers
 * (RecordReader, MetaReader, deriveKeys) expect a single header.
 *
 * After concatenation, patches the output header so its record_count (offset
 * 20, u64 LE) equals the sum of record_count across inputs, and its
 * lastHeight (offset 16, u32 LE) equals the max across inputs. Without this
 * MetaReader rejects the concatenated file when it contains records from
 * more than one input.
 *
 * Returns total bytes written (including the one header).
 */
function concatFilesWithHeader(inputPaths, outputPath, headerSize) {
    if (inputPaths.length === 0) throw new Error('concatFilesWithHeader: no input files')

    const hdrBuf = Buffer.alloc(headerSize)
    let totalRecordCount = 0n
    let maxLastHeight = 0

    const fd = fs.openSync(outputPath, 'w+')
    const BUF_SIZE = 256 * 1024
    const buf = Buffer.alloc(BUF_SIZE)
    let totalBytes = 0
    try {
        for (let i = 0; i < inputPaths.length; i++) {
            const stat = fs.statSync(inputPaths[i])
            const fdIn = fs.openSync(inputPaths[i], 'r')
            try {
                // Read this input's header to aggregate record_count + lastHeight.
                if (stat.size < headerSize) {
                    throw new Error(`${inputPaths[i]} is smaller than headerSize ${headerSize}`)
                }
                let hRead = 0
                while (hRead < headerSize) {
                    const n = fs.readSync(fdIn, hdrBuf, hRead, headerSize - hRead, hRead)
                    if (n === 0) throw new Error(`short header read in ${inputPaths[i]}`)
                    hRead += n
                }
                totalRecordCount += hdrBuf.readBigUInt64LE(20)
                const lastH = hdrBuf.readUInt32LE(16)
                if (lastH > maxLastHeight) maxLastHeight = lastH

                // First file: copy entirely. Others: skip header.
                let pos = (i === 0) ? 0 : headerSize
                while (pos < stat.size) {
                    const toRead = Math.min(BUF_SIZE, stat.size - pos)
                    const n = fs.readSync(fdIn, buf, 0, toRead, pos)
                    if (n === 0) break
                    fs.writeSync(fd, buf, 0, n)
                    totalBytes += n
                    pos += n
                }
            } finally {
                fs.closeSync(fdIn)
            }
        }

        // Patch aggregated record_count (offset 20, u64 LE) and lastHeight
        // (offset 16, u32 LE) into the output header.
        const patch = Buffer.alloc(8)
        patch.writeUInt32LE(maxLastHeight, 0)
        fs.writeSync(fd, patch, 0, 4, 16)
        patch.writeBigUInt64LE(totalRecordCount, 0)
        fs.writeSync(fd, patch, 0, 8, 20)
    } finally {
        fs.closeSync(fd)
    }
    return totalBytes
}

/**
 * Find files matching a glob-like prefix+suffix in a directory.
 * Returns paths sorted by name (which sorts by height range).
 */
function findFiles(dir, prefix, suffix) {
    return fs.readdirSync(dir)
        .filter(f => f.startsWith(prefix) && f.endsWith(suffix))
        .sort()
        .map(f => path.join(dir, f))
}

// --------------- phases ---------------

async function phaseDump(args, dirs) {
    log('DUMP', `dumping blocks to ${dirs.dumps}`)
    const dumpArgs = [
        '--network', args.network,
        '--from', String(args.from),
        '--chunk-size', String(args.chunkSize),
        '--out', dirs.dumps,
    ]
    if (args.to !== null) {
        dumpArgs.push('--to', String(args.to))
    } else {
        dumpArgs.push('--tip-safety', String(args.tipSafety))
    }
    await runChild(path.join(BULK_SYNC_DIR, 'dump.js'), dumpArgs)
    const xdmpFiles = findFiles(dirs.dumps, 'blocks-', '.xdmp')
    log('DUMP', `done: ${xdmpFiles.length} .xdmp files`)
    return xdmpFiles
}

async function phaseParse(args, dirs, xdmpFiles) {
    const maxWorkers = args.workers || xdmpFiles.length
    log('PARSE', `parsing ${xdmpFiles.length} dumps with up to ${maxWorkers} parallel workers`)

    // Process in batches of maxWorkers
    for (let i = 0; i < xdmpFiles.length; i += maxWorkers) {
        const batch = xdmpFiles.slice(i, i + maxWorkers)
        const promises = batch.map(xdmpPath => {
            const parseArgs = ['--in', xdmpPath, '--out', dirs.parsed]
            return runChild(path.join(BULK_SYNC_DIR, 'parse-worker.js'), parseArgs)
        })
        await Promise.all(promises)
        log('PARSE', `batch done: ${Math.min(i + maxWorkers, xdmpFiles.length)}/${xdmpFiles.length}`)
    }

    log('PARSE', 'all workers done')
}

async function phaseMerge(args, dirs) {
    const allOutputsPath = path.join(dirs.merge, 'all-outputs.dat')
    const allSpendsPath  = path.join(dirs.merge, 'all-spends.dat')
    const allMetaPath    = path.join(dirs.merge, 'all-meta.dat')

    // Skip concat if prior crash (or prior run) already produced the three concatenated files.
    if (fs.existsSync(allOutputsPath) && fs.existsSync(allSpendsPath) && fs.existsSync(allMetaPath)) {
        const outMB = (fs.statSync(allOutputsPath).size / 1024 / 1024).toFixed(1)
        const spdMB = (fs.statSync(allSpendsPath).size / 1024 / 1024).toFixed(1)
        log('MERGE', `concat skipped (reusing: outputs=${outMB}MB, spends=${spdMB}MB)`)
    } else {
        log('MERGE', 'concatenating per-worker files')

        const outputFiles = findFiles(dirs.parsed, 'outputs-', '.dat')
        const spendFiles  = findFiles(dirs.parsed, 'spends-', '.dat')
        const metaFiles   = findFiles(dirs.parsed, 'meta-', '.dat')

        log('MERGE', `found ${outputFiles.length} output files, ${spendFiles.length} spend files, ${metaFiles.length} meta files`)

        const outBytes = concatFilesWithHeader(outputFiles, allOutputsPath, HEADER_SIZE)
        const spdBytes = concatFilesWithHeader(spendFiles, allSpendsPath, HEADER_SIZE)
        log('MERGE', `concatenated: outputs=${(outBytes / 1024 / 1024).toFixed(1)}MB, spends=${(spdBytes / 1024 / 1024).toFixed(1)}MB`)

        concatFilesWithHeader(metaFiles, allMetaPath, HEADER_SIZE)
    }

    // Sort outputs by (txHash8 + vout)
    log('MERGE', 'sorting outputs by txHash8+vout')
    const sortedOutputsPath = path.join(dirs.merge, 'outputs-sorted.dat')
    const ramBudgetBytes = args.ramBudget * 1024 * 1024
    const outSortResult = await externalSort({
        inputPath:   allOutputsPath,
        outputPath:  sortedOutputsPath,
        recordSize:  OUTPUTS_RECORD_SIZE,
        keySize:     OUTPUTS_KEY_SIZE,
        tmpDir:      dirs.sortTmp,
        headerSize:  HEADER_SIZE,
        ramBudgetBytes,
        onProgress(ev) {
            if (ev.phase === 'sort-done' || ev.phase === 'merge-done') {
                log('MERGE', `  sort outputs: ${ev.phase} — ${JSON.stringify(ev)}`)
            }
        }
    })
    log('MERGE', `outputs sorted: ${outSortResult.recordsSorted} records`)

    // Sort spends by (prevTxHash8 + prevVout)
    log('MERGE', 'sorting spends by prevTxHash8+prevVout')
    const sortedSpendsPath = path.join(dirs.merge, 'spends-sorted.dat')
    const spdSortResult = await externalSort({
        inputPath:   allSpendsPath,
        outputPath:  sortedSpendsPath,
        recordSize:  SPENDS_RECORD_SIZE,
        keySize:     SPENDS_KEY_SIZE,
        tmpDir:      dirs.sortTmp,
        headerSize:  HEADER_SIZE,
        ramBudgetBytes,
        onProgress(ev) {
            if (ev.phase === 'sort-done' || ev.phase === 'merge-done') {
                log('MERGE', `  sort spends: ${ev.phase} — ${JSON.stringify(ev)}`)
            }
        }
    })
    log('MERGE', `spends sorted: ${spdSortResult.recordsSorted} records`)

    // Anti-join: outputs - spends = live UTXOs
    log('MERGE', 'anti-join: outputs - spends = live UTXOs')
    const liveUtxosPath = path.join(dirs.merge, 'live-utxos.dat')
    const joinResult = await leftAntiJoin({
        leftPath:        sortedOutputsPath,
        rightPath:       sortedSpendsPath,
        outputPath:      liveUtxosPath,
        leftRecordSize:  OUTPUTS_RECORD_SIZE,
        rightRecordSize: SPENDS_RECORD_SIZE,
        keySize:         OUTPUTS_KEY_SIZE,
        leftHeaderSize:  0,   // sorted output has no header (externalSort strips it)
        rightHeaderSize: 0,   // sorted output has no header
        onProgress(ev) {
            if (ev.phase === 'done') log('MERGE', `  anti-join: ${ev.emitted} live, ${ev.canceled} spent`)
        }
    })
    log('MERGE', `live UTXOs: ${joinResult.emitted}`)

    // Derive LevelDB keys
    log('MERGE', 'deriving LevelDB keys')
    const keysResult = await deriveKeys({
        metaPath:         allMetaPath,
        outputsPath:      allOutputsPath,
        liveUtxosPath,
        spendsByPrevPath: sortedSpendsPath,
        outDir:           dirs.keys,
        tmpDir:           dirs.deriveTmp,
        ramBudgetBytes,
        onProgress(ev) {
            if (ev.phase && ev.phase.includes('done')) {
                log('MERGE', `  derive: ${ev.phase}`)
            }
        }
    })
    log('MERGE', `keys derived: ${JSON.stringify(keysResult.stats)}`)

    return keysResult
}

async function phaseLoad(args, dirs) {
    log('LOAD', `loading keys into ${args.db} (${args.backend})`)
    const result = await loadKeys({
        keysDir:    dirs.keys,
        dbPath:     args.db,
        backend:    args.backend,
        batchSize:  args.batchSize,
        onProgress(ev) {
            if (ev.phase === 'prefix-done') {
                log('LOAD', `  ${ev.prefix}: ${ev.count} records (${ev.elapsed_ms}ms)`)
            }
        }
    })
    const total = Object.values(result.stats).reduce((a, b) => a + b, 0)
    log('LOAD', `done: ${total} records in ${result.elapsed_ms}ms`)
    return result
}

// --------------- main ---------------

async function main() {
    const args = parseArgs(process.argv)

    // Setup directory structure
    const dirs = {
        dumps:     path.join(args.out, 'dumps'),
        parsed:    path.join(args.out, 'parsed'),
        merge:     path.join(args.out, 'merge'),
        sortTmp:   path.join(args.out, 'merge', 'sort-tmp'),
        deriveTmp: path.join(args.out, 'merge', 'derive-tmp'),
        keys:      path.join(args.out, 'keys'),
    }
    for (const d of Object.values(dirs)) {
        fs.mkdirSync(d, { recursive: true })
    }

    const t0 = Date.now()

    log('ORCHESTRATOR', `network=${args.network} from=${args.from} backend=${args.backend}`)
    log('ORCHESTRATOR', `out=${args.out} db=${args.db}`)

    // Phase 1: Dump
    let xdmpFiles
    if (args.skipParse || args.skipDump) {
        xdmpFiles = findFiles(dirs.dumps, 'blocks-', '.xdmp')
        log('DUMP', `skipped (reusing ${xdmpFiles.length} existing .xdmp files)`)
    } else {
        xdmpFiles = await phaseDump(args, dirs)
    }

    // Phase 2: Parse
    if (args.skipParse) {
        log('PARSE', 'skipped (reusing existing .dat files)')
    } else {
        await phaseParse(args, dirs, xdmpFiles)
    }

    // Phase 3: Merge
    const mergeResult = await phaseMerge(args, dirs)

    // Phase 4: Load
    const loadResult = await phaseLoad(args, dirs)

    const elapsed = Date.now() - t0
    log('ORCHESTRATOR', `pipeline complete in ${fmtDuration(elapsed)}`)
    log('ORCHESTRATOR', `DB at ${args.db} (${args.backend}) — ready for validate-db`)
}

main().catch(err => {
    console.error('[orchestrator] FATAL:', err.message)
    if (err.stack) console.error(err.stack)
    process.exit(1)
})
