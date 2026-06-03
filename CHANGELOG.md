# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `src/XChainBlockDecoder.js` — the `blockFromBuffer` HogEx detection guard now accepts Litecoin transaction version 1 in addition to version 2 (`txVersion == 0x01 || txVersion == 0x02`), matching the guard already used in the single-transaction `txFromHex` path. Previously the block-processing path stripped the MWEB marker+flag only for version-2 HogEx transactions while the mempool/single-tx path handled both versions, so a version-1 HogEx would have been parsed correctly off the mempool but misparsed when read from a block. HogEx transactions are version 2 in practice today, so this corrected a latent inconsistency with no change to any current code path; the two decoder entry points are now symmetric.
- `src/XChainUtxoTracker.js` — the main `start()` loop now copies input/block hash buffers before byte-reversing them (`Buffer.from(block.prevHash).reverse()` for the block-hash path, `Buffer.from(nextInput.hash).reverse()` in the Pass-2 input-collection loop), matching the defensive form already used in `parseTxInputs`/`parseTxOutputs`. `Buffer.prototype.reverse()` mutates in place and returns the same buffer, so the previous bare `.reverse()` calls flipped the shared decoded-transaction/block buffers in place. This was benign today (the buffers are discarded after each block iteration and the reversed bytes never reach the REST/RPC surface), but it would silently corrupt any future path that re-read those buffers after the batch (a diagnostic log, a pass-3 extension, or a mempool cross-check). Copying first leaves the originals intact and makes every reversal site in the file consistent.
- `src/api.js` — `AUX_POW` is now parsed as an explicit boolean (`process.env.AUX_POW === 'true' || process.env.AUX_POW === '1'`) instead of being passed through as the raw environment string. The value flows into `XChainUtxoTracker` and is consumed in bare truthy checks, so any non-empty string — including `AUX_POW=false`, `AUX_POW=0`, or `AUX_POW=no` — previously evaluated as truthy and *enabled* AuxPoW mode, the opposite of operator intent. Setting `AUX_POW=false` now correctly disables it on every chain.

### Removed
- `src/BlockchainConnector.js` — removed the unused `getMempoolEntry(txid)` method (wrapping the `getmempoolentry` JSON-RPC call) along with its dedicated unit test. The tracker's indexing flow never called it; an unexercised RPC wrapper risked silently drifting out of sync with coin-node response shapes (e.g. Bitcoin Core's `fee` → `fees.base` field rename) for any future consumer. Removing it shrinks the connector surface to what the service actually uses.

### Added
- `src/api.js` — the three address REST endpoints (`/utxos/:address`, `/balance/:address`, `/info/:address`) now expose mempool readiness so callers can distinguish a genuinely empty result from one served before the in-memory mempool has reconverged after a restart. The mempool DB is volatile and reads as empty until the first `updateMempool()` scan completes post-restart, during which `balances.pending` and pending UTXOs are understated with no prior indicator — a caller polling `/info/:address` in that window could wrongly conclude a pending transaction was dropped. All three endpoints now set an `X-Mempool-Ready: true|false` response header (evaluated per request via `tracker.isSynced()`, the same gate the JSON-RPC `get_sync_status`/`is_quiescent` methods already use), and `/info/:address` additionally carries a `mempool_ready` boolean in its JSON body. Existing response bodies are otherwise unchanged — the bare-array (`/utxos`) and bare-number (`/balance`) shapes are preserved, so the readiness signal rides the header rather than restructuring them.
- `.env.example` — added a configuration template enumerating every environment variable the tracker reads (coin/network, coin-node RPC, API port, bulk-sync tuning), with safe regtest/placeholder defaults and inline comments, so operators have a single reference for configuring the service instead of reading the source.
- `src/db.js` — the MariaDB connection pool now sets `queryTimeout: parseInt(process.env.DB_QUERY_TIMEOUT) || 30000`. The pool already disabled the connect timeout (`connectTimeout: 0`) and had no query timeout either, so a slow or lock-blocked statement had no upper bound and could hang a pooled connection indefinitely with no timeout-based recovery. A query now aborts after the configured timeout (30s default, overridable via `DB_QUERY_TIMEOUT`) instead of hanging. Matches the pattern already used by `xchain-hub`.
- `test/unit/classiclevel-behavior.test.js` + `test/ondisk-classiclevel-hook.js` — a classic-level behaviour-contract test (range scan `0xFF` upper-bound inclusion, iterator snapshot consistency under a concurrent delete, zero-length-value round-trip, `getMany`/missing-key semantics) that guards the LevelDB behaviours `LevelUpDb.js` relies on, plus a Mocha `--require` hook and `test:unit:ondisk` / `test:integration:ondisk` scripts that re-run the existing suites against the real on-disk engine instead of the in-memory `memory-level` sibling.
- `test/e2e/persistence.test.js` — new E2E case `G8: mempool pending balance reconverges after restart`. The existing persistence cases (`G2`/`G4`/`G5`/`G7`) only assert that *confirmed* UTXO state survives a stop/restart cycle, and the mempool lifecycle cases (`C1`–`C5`) never restart the tracker. Since the mempool DB is in-memory, it is discarded on every restart and pending balances must be rebuilt by the next `updateMempool()` scan — a property that previously had no regression guard. The new case funds an address, adds an unconfirmed spend, stops and restarts the tracker, asserts that confirmed state survived while pending correctly reads zero in the reconvergence window, then triggers `updateMempool()` and asserts pending reconverges to the live mempool (10 BTC credited to the recipient, an 11 BTC net deduction reflected on the spender). Test-only; no source changes.

### Changed
- `package.json` — pinned `mariadb` 3.5.2, `bitcoinjs-lib` 6.1.7, `ecpair` 2.1.0, `bip32` 4.0.0, `tiny-secp256k1` 2.2.4 to exact versions (dropped the `^` caret ranges) so every install resolves a byte-identical dependency tree across operator nodes, matching the versions already frozen in `package-lock.json`. No source changes.
- `src/XChainUtxoTracker.js` — reduced the inter-batch sleep in `updateMempool()` from 10000 ms to 1500 ms (new `MEMPOOL_INTER_BATCH_SLEEP` constant). The mempool is parsed in batches of `MEMPOOL_BATCH_SIZE` (1000) txs with one sleep between batches for CPU/IO breathing room. At 10000 ms the cumulative sleep for a large mempool exceeded `MEMPOOL_INTERVAL` (60000 ms) — ~490s of sleep alone at 50k txs — so `mempoolBusy` stayed locked across every scheduled tick and pending-balance queries went stale for the whole multi-batch window. At 1500 ms the same 50k-tx pass sleeps ~73.5s total, keeping reconvergence bounded while preserving the throttle. Also added a one-line up-front log (`Mempool update: N batches required, estimated minimum reconvergence Ns`), emitted only when the mempool spans more than one batch, so operators can correlate stale pending-balance windows with mempool depth during fee spikes. The existing guard that skips the sleep after the final batch is unchanged.
- `src/BlockchainConnector.js` — the two batched block-fetch methods (`getBlocksBatch` for BTC/LTC and `getBlocksBatchWithoutAuxPow` for Dogecoin) now retry on transient connection timeouts instead of throwing on the first one. Both methods issue 2–3 batched JSON-RPC HTTP POSTs (getblockhash / getblockheader / getblock), and none of those five call sites had any retry logic: a single `ECONNABORTED` timeout on any one request threw immediately and discarded the entire batch window. In the live-sync prefetch path (`XChainUtxoTracker.fillPrefetchQueue`) the rejection is swallowed by the queue's unhandled-rejection guard, silently evicting every queued height and forcing the main loop to fall back to slow one-block-at-a-time fetching until the next fill cycle; in the bulk-sync dump path a timeout aborted the whole chunk with no recovery. A new `postWithRetry(data)` helper now wraps every batch POST with the same bounded ECONNABORTED retry loop already used by `getBlockHeader` (up to 10 attempts) plus a short 500 ms backoff between tries, so batch throughput holds under flaky RPC conditions. The single-block methods are unchanged, and the prefetch queue's outer rejection guard still correctly covers the case where retries are exhausted and the method throws.
- **Storage backend migrated from RocksDB to `classic-level` (LevelDB).** `package.json` drops the discontinued `rocksdb@5.2.1` + `levelup`/`leveldown`/`memdown`/`encoding-down` stack — whose native addon fails to compile on Node 22, breaking `npm ci` on every clean checkout — in favour of `classic-level@^3` (on-disk) and `memory-level@^3` (in-memory tests), which ship Node 22 prebuilds and need no compiler toolchain. `src/LevelUpDb.js`, `src/XChainUtxoTracker.js`, and the `src/bulk-sync/` tools were rewritten to the `abstract-level` API: `.get` returns `undefined` on a miss instead of throwing `NotFound` (~8 call sites, incl. `removeOutputWithInput` whose catch-all no longer swallows real I/O errors), `createReadStream` range scans become `db.iterator()` `[key, value]` async iteration (~14 sites), and string metadata values are Buffer-wrapped under the buffer value-encoding. Bulk-sync's `--backend` flag is retired (classic-level only; legacy flag tolerated and ignored). Requires Node ≥ 22. **On-disk format changes from RocksDB SST to LevelDB**, so every deployed node must resync from its coin node or restore from a freshly-built bootstrap — do not upgrade in place. Verified byte-identical key-value output vs the RocksDB backend on a 618-block regtest chain (0 diffs / 0 missing / 0 extra across 11,979 keys) and via a differential dual-backend harness (identical across 2,000 randomized rounds and an unclean-crash WAL-recovery check).
- `src/XChainUtxoTracker.js` — the live-sync block prefetch loop (`fillPrefetchQueue`) now fetches AuxPoW chains (e.g. Dogecoin) with the batched `getBlocksBatchWithoutAuxPow(heights)` RPC path instead of fetching each block in the prefetch window individually. The AuxPoW branch previously issued three sequential JSON-RPC round-trips per block (getblockhash → getblockheader → getblock), so a 10-block prefetch window cost ~30 HTTP requests, while the non-AuxPoW (BTC/LTC) branch already collapsed the same window into ~2 batched requests. The batch variant — already used by the bulk-sync path and already performing the AuxPoW header stripping correctly — returns the identical `{ height, hash, hex }` shape, so the queue-fill now mirrors the BTC/LTC branch exactly. This aligns Dogecoin live-sync catch-up throughput with BTC/LTC; sync output is unchanged, this is a round-trip reduction only.
- `package.json` — aligned the `mariadb` driver to the `^3.5.2` range used across the platform. The driver was previously pinned to `~3.4.5` (a patch-only range, one minor line behind the `xchain-dashboard` host); the caret range now tracks 3.x minor releases consistently with every other service, removing the version drift and the mix of `~`/`^` range operators across the platform. No source changes.
- Two `catch` blocks in `src/XChainUtxoTracker.js` (the reorg block-delete retry and the mempool raw-transaction fetch retry) now append the caught error to their fixed-message `console.log` call, so the failure detail is attached to the message line rather than logged separately or not at all.
- `src/LevelUpDb.js` — mempool cleanup now dispatches the per-txid LevelDB range scans concurrently instead of serially. `deleteInputsByHints` and `deleteOutputsByHints` previously walked their txid list with a `for…await` loop, so a large mempool eviction (e.g. 200 txids on a fee-bumped block) ran hundreds of range scans strictly one after another. Both helpers now fan the scans out with `Promise.all`, and `deleteAndCompareTxsNotInList` runs the inputs and outputs cleanup in parallel. LevelDB's read path is non-blocking and the write-batch accumulation is synchronous, so the result is identical but the per-refresh latency collapses from sum-of-scans to a single concurrent batch.

### Fixed
- `src/XChainUtxoTracker.js` — `verifyReorg()` now hard-aborts instead of silently corrupting the UTXO index when a reorg is deeper than the recovery window (`UNDO_BLOCKS` = 10). Spent-output recovery records (the K/M reverse index) are retained only for the most recent `UNDO_BLOCKS` blocks — `cleanupAgedBlocks()` purges them once a block ages out of that window. When a reorg rolled back further than 10 blocks, `processDeletedOutputs(hash, true)` found no recovery records for the aged-out blocks, restored nothing, and returned silently: the rollback still removed those blocks and advanced the stored height/hash, but the UTXO index was left permanently under-counted for any address that had outputs spent in the orphaned-beyond-window blocks. There was no counter, warning, or abort — the only log was a benign "N blocks were removed" line. `verifyReorg()` now counts rolled-back blocks and, once it has rolled back `UNDO_BLOCKS` blocks, emits a `console.error` and throws before touching the next (unrecoverable) block — naming the boundary block height and instructing the operator to perform a full resync from a known-good snapshot. A loud, actionable failure replaces silent index corruption. Deep reorgs beyond 10 blocks are negligible on Bitcoin mainnet but have historically occurred on Dogecoin/Litecoin and are reachable under regtest or adversarial conditions.
- `src/XChainUtxoTracker.js` — `updateMempool()` no longer permanently halts mempool indexing when the coin node goes down *after* `getRawMempool()` succeeds but during the subsequent `getRawTransactions()` fetches. The inner batch-fetch retry loop caught the error and `continue`d with a 1s sleep without advancing its index, so a node that stayed down spun that loop forever — keeping execution inside the outer `try` and never reaching the `finally` that clears `mempoolBusy`. The flag stayed stuck `true`, every later interval tick bailed with "Mempool is still busy", and the block-confirmation path (which spins on the same flag) deadlocked too, recoverable only by a process restart. The retry now counts consecutive `getRawTransactions()` failures and, after `MEMPOOL_MAX_TX_FETCH_RETRIES` (5) in a row, logs a warning and `break`s out of the batch loop so the `finally` fires, `mempoolBusy` resets, and the next interval tick retries cleanly; the counter resets to zero on any successful fetch so a brief blip doesn't accumulate toward the limit. A node outage now degrades to a skipped pass (the partial batch commits and the next full pass reconciles via `deleteAndCompareTxsNotInList`) instead of a permanent lock. Complements the post-fetch `try/finally` guard above, which only covered exceptions escaping the body — not this self-contained infinite retry.
- `src/XChainUtxoTracker.js` — `this.lastBlocks` is now sorted by block height (chain tip last) wherever it's loaded from `getLastStoredBlocks()` — both on startup and, critically, in the live-sync reorg branch that reloads it immediately before `verifyReorg()`. `getLastStoredBlocks()` returns the stored-block hashes in blockHash (lexicographic) order, but `removeFromLastBlocks()` requires the tip to be the last element; the unsorted list made `verifyReorg()` throw "Can't delete a block from the 'last blocks' if it's not the last one" on essentially every reorg and wedge the sync loop (the tracker stopped advancing). Added `loadLastBlocksSortedByHeight()` (orders by each block's B-prefix height record, ≤ `UNDO_BLOCKS` lookups) and use it at both load sites. Restores reorg handling — `test/e2e/reorg.test.js` 0→4 passing, full e2e 25/8→28/5 (residual failures are unrelated pre-existing balance-assertion rot).
- `src/XChainUtxoTracker.js` — `stopParsing()` and the parse-loop stop path now clear the recurring `mempoolInterval` timer (and null it) on shutdown. Previously the 60s mempool poll kept firing after a stop and could touch an already-closed database; the e2e suite had been masking this with a separate `stopTracker` cleanup helper (now removed in favour of the in-`stopParsing` cleanup).
- `src/XChainUtxoTracker.js` — `updateMempool()` no longer permanently halts mempool indexing when an exception escapes the parse/commit path. Only the `getRawMempool()` call and the happy-path tail reset the `mempoolBusy` mutex; the post-fetch body (`beginTransaction()`, `deleteAndCompareTxsNotInList()`, the per-batch `parseTransaction()` loop, `endTransaction()`) was unguarded, so a malformed-hex `txFromHex()` throw or a LevelDB I/O error left `mempoolBusy` stuck `true`. Every subsequent interval tick then logged "Mempool is still busy" and bailed, silently stagnating the mempool for the process lifetime (and stalling the block-confirmation path, which spins on the same flag). The whole post-fetch body is now wrapped in `try/catch/finally`: the `finally` always clears `mempoolBusy`, the `catch` logs the error and attempts a rollback `endTransaction(false)`. Matches the reset pattern already applied to the `getRawMempool()` section.
- `src/XChainUtxoTracker.js` / `src/LevelUpDb.js` — outputs created in a block that is later rolled back during a reorg are now removed from the live UTXO index. Previously `verifyReorg` restored only outputs that had been *spent* in the rolled-back block (via the K/M spend-recovery index), with no mechanism to delete outputs that were *created* in that block and never spent — their `O` (output) and `H` (hint) entries lingered in the index permanently, so `getBalanceInfo`/`getUtxosAddress` reported phantom UTXOs and inflated confirmed balances for any address that received funds in the orphaned block, cumulatively across reorgs. A new `W` creation-block reverse index (`[W][blockHash][txHash8][outputIndex]` → `scriptPubKey`) is written for every confirmed output at insert time; `verifyReorg` now scans the `W` prefix for the rolled-back block and deletes the corresponding `O`/`H`/`W` entries in the same atomic rollback batch, after K/M recovery so that an output both created and spent in the block is removed rather than revived. Note: this heals reorgs going forward only — a node that experienced a reorg before this index existed has no `W` entries for those outputs and must be re-indexed to clear any pre-existing phantom UTXOs. Integration test 4.3 now also asserts the recipient's balance returns to zero after the creating block is rolled back.
- `src/XChainUtxoTracker.js` — block-time mempool cleanup now commits as a single atomic batch. When a block is confirmed, the tracker eagerly evicts the now-mined transactions' records from the mempool DB. These deletions ran without a wrapping `beginTransaction()`/`endTransaction()`, and `deleteOutputsByHint`/`deleteInputsByHint` walk per-entry `for await` read streams that yield to the event loop, so a concurrent `updateMempool()` pass could capture some of a multi-output transaction's deletions into its batch while the rest wrote directly — briefly exposing a half-removed view (output record gone, spend-hint not yet) to balance and UTXO queries, momentarily overstating a pending balance. The cleanup is now wrapped in a dedicated mempool-DB transaction. Because that transaction shares a single accumulator with `updateMempool()`, the cleanup first acquires the existing `mempoolBusy` mutex (waiting for any in-flight mempool refresh to finish and releasing it in a `finally`) so the two never open overlapping transactions; `updateMempool()` already tolerates a busy tick by skipping and retrying on its next interval.
- `src/XChainBlockDecoder.js` — `blockFromBuffer` now strips the Litecoin MWEB marker+flag from a block's final transaction when the flag is the combined segwit+MWEB value `0x09`, not only the pure-MWEB `0x08`. The single-transaction decode path (`txFromHex`) already handled both flag values, but the block-level last-transaction check matched only `0x08`; a Litecoin block whose final (HogEx) transaction carried `0x09` would have been handed unstripped marker bytes and thrown a `Transaction.fromBuffer` parse error, stalling UTXO indexing. HogEx extension transactions are observed to use `0x08` in practice, so this is a defensive consistency fix with no behavioural change on current data.

## [1.0.10] - 2026-05-29

### Changed
- Dependency installs are now reproducible: `package-lock.json` is committed to the repo (previously git-ignored) and the Docker image is built with `npm ci` instead of `npm install`. `npm ci` installs the exact dependency tree recorded in the lockfile and fails the build if the lockfile is missing or out of sync with `package.json`, so a container image can no longer silently pick up newer transitive dependency versions than were tested.

## [1.0.9] - 2026-05-28

### Security
- Pin `qs` to `^6.15.2` via an `overrides` entry, remediating GHSA-q8mj-m7cp-5q26 (moderate DoS: `qs.stringify` throws a `TypeError` on null/undefined entries in comma-format arrays when `encodeValuesOnly` is set). The override forces the patched version across all transitive dependency paths, including the legacy `qs@6.5.5` pulled in by the deprecated `request` package.

## [1.0.8] - 2026-05-28

### Fixed
- Mempool ingest corrupted the previous-transaction hash stored in UTXO spend-hint (J) records. `parseTransaction` and `parseTxInputs` reversed each input's hash buffer in place once per consumer (spend lookup, input insert, and hint insert), so a second consumer received doubly-reversed wire-order bytes instead of big-endian display order. When a mempool transaction was later evicted without being mined, the hint-driven cleanup built a non-existent spend key from those corrupted bytes and left the real UTXO record permanently stale — hiding a valid confirmed UTXO from balance and UTXO queries for the lifetime of the process. The hash is now reversed on a copy of the buffer, so the shared source bytes are never mutated and every consumer receives identical big-endian display-order bytes. This also keeps a transaction object reusable across the mempool-ingest and block-confirmation passes without its spend lookup breaking.

## [1.0.7] - 2026-05-28

### Removed
- Unused `mysql` dependency — the service connects via the `mariadb` driver only; the legacy `mysql` package was never imported and carried known CVEs in its SSL-handling layer.

## [1.0.6] - 2026-04-06

### Changed
- Move coverage badge to its own line in README.md for cleaner formatting

## [1.0.5] - 2026-04-05

### Changed
- `README.md` — rewrote to match platform README structure: added version/test/coverage badges, Features list (15 items), Documentation table linking to xchain-documentation repo, Quick Start with `.env` example, Scripts table (19 commands), Test Suite breakdown (8 categories, 618+ tests), copyright footer
- Moved Stryker mutation testing configs and plugins from repo root into `test/mutation/`: `stryker*.json`, `.mocharc.stryker.yml`, `stryker-plugins/`
- Updated all `mutate*` npm scripts in `package.json` to reference new `test/mutation/` paths
- Updated `mochaOptions.config` in all Stryker configs to `test/mutation/.mocharc.stryker.yml`
- Moved `bufferutils.js` from repo root into `src/`; updated Dockerfile, test imports, Stryker configs, and custom mutant runner references

## [1.0.4] - 2026-04-05

### Added
- StrykerJS mutation testing setup with per-priority configs (P1/P2/P3), quick mode, and incremental mode
- Custom buffer mutator plugin for endianness swap and LevelDB key prefix byte swap mutations
- Standalone custom mutation runner (`stryker-plugins/run-custom-mutants.js`) for Buffer/encoding-specific mutations
- Mocha config for Stryker runs (`.mocharc.stryker.yml`) with 30s timeout override
- Local `bufferutils.js` test coverage via Module resolution patching (enables mutation testing of patched file)
- npm scripts: `mutate`, `mutate:quick`, `mutate:p1`, `mutate:p2`, `mutate:p3`, `mutate:incremental`, `mutate:custom`, `mutate:custom:p1`

### Changed
- `src/api.js`: wrapped `startApi()` in `require.main === module` guard to support safe `require()` by Stryker workers

## [1.0.3] - 2026-04-05

### Added
- Chaos engineering test suite with 31 tests across 10 experiments targeting LevelDB persistence, RPC resilience, state corruption, and concurrency
- Fault injection helpers: batch write failure, read latency, state anchor corruption, reorg forcing
- Tests covering: batch write atomicity, disk-full recovery, crash mid-batch, read latency degradation, state anchor self-healing, reorg during uncommitted batch, RPC connection loss, malformed RPC responses, concurrent queries during commit, mempool flood
- npm script: `test:chaos`

## [1.0.2] - 2026-04-05

### Added
- Performance and load testing suite with 23 tests across 7 scenarios: sustained indexing throughput, spike load recovery, HTTP query load (via autocannon), combined indexing + query load, mempool stress, database growth degradation, and reorg performance
- Configurable test scale via `PERF_SCALE` env var (small/medium/large) with JSON results export via `PERF_RESULTS_DIR`
- npm scripts: `test:perf`, `test:perf:quick`, `test:perf:deep`

## [1.0.1] - 2026-04-05

### Fixed
- Mempool spend detection — `getInput()` now truncates txid to txHash8 to match key format used by `insertInput()`, fixing broken mempool spend detection in `getBalanceInfo()` and `getUtxosAddress()`

### Added
- Fuzz testing suite with 12 campaigns (P0–P3) using fast-check, covering block decoding, LevelDB encoding, balance calculation, transaction processing, address validation, reorg handling, mempool operations, connector responses, API endpoints, bootstrap filenames, and configuration parsing
- npm scripts: `test:fuzz`, `test:fuzz:quick`, `test:fuzz:deep`

## [1.0.0] - 2026-04-03

### Added
- Bootstrap functionality for creating and restoring LevelDB snapshots
- Balance API call (`get_balance`)
- System info API call (`get_info`) with bitcoinjs-lib Litecoin network support
- Dogecoin block parsing support
- Litecoin block (hogex) parsing via modified bitcoinjs-lib
- Litecoin witness program version 9 mempool transaction handling
- Reorg detection and automatic chain reorganization recovery
- Rolling 1000-block ETA window with day/hour/minute display
- SPDX license header and LICENSE/NOTICE links in README
- `.gitignore` for `.DS_Store` files

### Changed
- **Binary key/value encoding** — replaced hex string keys and values with raw binary encoding, reducing DB size ~50%
- **Reduced txid storage** — txid fields in T, I, J keys reduced to 8 bytes, further shrinking DB footprint
- **Active-UTXO-only storage** — store only unspent outputs instead of all outputs, reducing DB size ~60-70%
- **Concurrent block prefetch** — pre-fetch up to 10 blocks concurrently via JSON-RPC batch requests with HTTP keepAlive, reducing RPC idle time
- **Parallel transaction processing** — inputs and outputs processed concurrently within each transaction using two-pass approach
- **Increased batch sizes** — skip redundant LevelDB reads and use larger batch commits for throughput
- Default mode changed to not delete spent outputs (configurable via `REMOVE_SPENT`)
- Spent outputs now retained for a configurable number of blocks before deletion
- Renamed from `xchain_address_indexer` to `xchain_utxo_tracker`
- API listens on port specified by `API_PORT` environment variable
- Dockerfile creates data directory and conditionally copies `.env`
- bitcoinjs-lib downgraded from 7.0.0 to 6.1.7 for performance; fixed double buffer block hex string

### Fixed
- Range scan key boundary — `rangeEnd` now appends `0xFF` correctly so scans don't miss keys
- Reorg recovery — re-sync `lastBlocks` array and fix stale `startTimeStamp` reference after chain reorganization
- Suppress unhandled rejections from discarded prefetch promises during reorg
- Null guard on `deletedTransactionArray` in `processDeletedOutputs`
- Reduce batch size and increase heap to prevent OOM on large blocks (e.g., BRC-20 inscription blocks)
- Skip S/Z prefix writes in `insertOutputScriptBlock` for mempool transactions
- Increase axios timeout from 5s to 30s for concurrent prefetch reliability
- Handle null `blockHash` in `encodeTx` for mempool transactions
- Defer K/M cleanup to after batch commit so spent UTXO backups are actually purged
- Warn instead of crash for missing output hints from pre-`REMOVE_SPENT` data
- Handle missing `transactionArray` key in `getTransactionValue`
- Fix `get_input_from_key_pattern` bug documented in README update
- Replace async stream handlers with `for-await-of` to prevent race conditions
- Bootstrap creation and restoration progress now reaches 100%
- BigInt removed from Litecoin block header parsing (compatibility fix)
- bitcoinjs-lib `bufferutils` patched to work with bigint when parsing tx output values
- Reorg no longer throws when last block is null
- Reorg crash on chain tip mismatch resolved
- UTXO tracker waits for coin node to synchronize before starting to parse
- Fixed wrong bitcoin library reference after rename
- Fixed wrong variable name in early environment setup
- Fixed `updateMempool` performance (async handling)
