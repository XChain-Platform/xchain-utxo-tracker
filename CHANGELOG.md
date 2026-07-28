# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Production-scale perf harness (`test/performance/mainnet-scale-queries.perf.js`) that builds an on-disk LevelDB up to BTC-mainnet size and asserts exact address-scan and coin-selection results inside a flat time budget.

### Fixed
- Pre-wipe restore aborts routed to resume (not fail-loud post-wipe path), getbootstrap writes the .sha256 sidecar, derive-keys drops the dead fullTxHash field, legacy fm.js removed.

### Changed
- Gate AuxPoW block-stripping on the coin's declared `wireFormat` in the canonical coin registry (`src/coins`) in both the live worker and the bulk seeder, instead of hardcoded coin-name checks, so onboarding a merge-mined chain is a registry edit; conformance now asserts every coin declares a handled `wireFormat`.
- Single-source the per-chain reorg `undoBlocks` table in `src/undo-blocks.js` (imported by the live worker and the bulk seeder) so a per-chain re-tune can no longer drift between them and re-open the per-chain UTXO reorg gap.
- Correct the bulk-sync reorg-invariant comments and operator log: K and M are skipped, W is seeded and windowed ().

### Fixed
- Route the bootstrap/restore restart paths through the same guarded `launchTracker()` helper as the primary boot, so a polling-loop throw after a snapshot/restore still rolls back and logs `[fatal]` instead of surfacing as a bare unhandled rejection.

## [1.0.11] - 2026-07-16

### Fixed
- LevelUpDb exports the remaining key builders and rangeEnd; new key-schema invariant suite pins binary key layouts, prefix uniqueness, rangeEnd coverage, and registry completeness against scan-bounds drift ().


## [1.0.10] - 2026-06-20

### Added
- `getUtxosAddress()` now rejects outputs whose resolved txid is shorter than 64 chars (pre-migration zero-hash records), throwing a descriptive error instead of forwarding a truncated hash to the encoder where it would silently build a malformed PSBT.
- `get_sync_status` JSON-RPC response now includes a `synced` boolean derived from the tracker's own `SYNCED_THRESHOLD` so callers don't need to replicate the threshold locally.
- The three address REST endpoints (`/utxos/:address`, `/balance/:address`, `/info/:address`) now expose mempool readiness via an `X-Mempool-Ready` header (and a `mempool_ready` body field on `/info`) so callers can distinguish empty results from results served before the first post-restart `updateMempool()` scan.
- `.env.example` configuration template enumerating every environment variable the tracker reads, with safe regtest/placeholder defaults and inline comments.
- `src/db.js` MariaDB connection pool now sets `queryTimeout` (`DB_QUERY_TIMEOUT`, default 30000 ms) to prevent hung connections on slow or lock-blocked statements.
- `test/unit/classiclevel-behavior.test.js` + `test/ondisk-classiclevel-hook.js`: behaviour-contract tests for the LevelDB operations `LevelUpDb.js` relies on, plus `test:unit:ondisk` / `test:integration:ondisk` scripts that re-run existing suites against the real on-disk engine.
- `test/e2e/persistence.test.js` case `G8`: asserts that pending mempool balance reconverges correctly after a tracker stop/restart cycle.

### Changed
- `package.json`: pinned `mariadb` 3.5.2, `bitcoinjs-lib` 6.1.7, `ecpair` 2.1.0, `bip32` 4.0.0, `tiny-secp256k1` 2.2.4 to exact versions (dropped `^` caret ranges) to ensure a byte-identical dependency tree across operator nodes.
- `updateMempool()` inter-batch sleep reduced from 10000 ms to 1500 ms (new `MEMPOOL_INTER_BATCH_SLEEP` constant) so cumulative sleep no longer exceeds `MEMPOOL_INTERVAL` on large mempools; adds a one-line up-front log when the mempool spans more than one batch.
- `getBlocksBatch` and `getBlocksBatchWithoutAuxPow` now retry on transient `ECONNABORTED` timeouts (up to 10 attempts, 500 ms backoff) via a new `postWithRetry` helper, matching the retry logic already on `getBlockHeader`.
- Storage backend migrated from RocksDB to `classic-level` (LevelDB): drops the discontinued `rocksdb@5.2.1` stack (fails on Node 22) in favour of `classic-level@^3` / `memory-level@^3`; rewrites `LevelUpDb.js`, `XChainUtxoTracker.js`, and `src/bulk-sync/` to the `abstract-level` API. Every deployed node must resync; on-disk format changes from RocksDB SST to LevelDB. Bulk-sync `--backend` flag retired (tolerated and ignored).
- AuxPoW live-sync prefetch now uses `getBlocksBatchWithoutAuxPow(heights)` instead of per-block individual fetches, aligning Dogecoin catch-up throughput with BTC/LTC.
- `package.json`: aligned `mariadb` driver to the `^3.5.2` range used platform-wide (was `~3.4.5`).
- Two `catch` blocks in `src/XChainUtxoTracker.js` (reorg block-delete retry, mempool raw-tx fetch retry) now append the caught error to their log line instead of logging separately or not at all.
- `deleteInputsByHints` and `deleteOutputsByHints` now fan per-txid LevelDB range scans out with `Promise.all` instead of a serial `for…await` loop; `deleteAndCompareTxsNotInList` runs inputs and outputs cleanup in parallel.
- Dependency installs are now reproducible: `package-lock.json` is committed and the Docker image is built with `npm ci` instead of `npm install`.

### Fixed
- `src/CryptoNetworks.js`: corrected the Litecoin dust threshold from `546` to `5460` litoshis for all three `litecoin-*` networks to match Litecoin Core's relay policy (10x Bitcoin's dust relay fee).
- `get_input_from_key_pattern` JSON-RPC: closed an unauthenticated memory-exhaustion vector where a 32-char all-invalid hex pattern cleared the string-length gate (via `Buffer.from` silent truncation), triggered a full-database prefix scan, and accumulated results into an unbounded array. Fix adds a non-hex character gate, a 2-byte minimum key-prefix floor in `getValuesFromKeyPattern`, and a `maxValues` hard ceiling wired to `MAX_ADDRESS_OUTPUTS`.
- `start()` loop now re-polls the chain tip on a 30-second wall-clock interval during catch-up (new `BLOCKCHAIN_INFO_REFRESH_MS`), preventing `synced` from being set prematurely and keeping the `confirmations` field accurate during long initial syncs.
- Reorg-handling branch in `start()` now persists the `P_PENDING_CLEANUP_KEY` record outside the rolled-back transaction so aged-out K/M cleanup entries are not stranded on disk.
- `blockFromBuffer` HogEx detection guard now accepts Litecoin transaction version 1 in addition to version 2, making the block-processing path symmetric with the single-tx `txFromHex` path.
- Input/block hash buffers in `start()` are now copied before byte-reversing (`Buffer.from(...).reverse()`), preventing in-place mutation of shared decoded-transaction buffers.
- `AUX_POW` env var is now parsed as an explicit boolean (`=== 'true' || === '1'`), so `AUX_POW=false` correctly disables AuxPoW mode instead of evaluating as truthy.
- `verifyReorg()` now hard-aborts with a `console.error` and a throw when a reorg exceeds the `UNDO_BLOCKS` (10) recovery window, replacing silent UTXO under-counting.
- `updateMempool()` no longer permanently locks `mempoolBusy` when the coin node goes down mid-batch: after `MEMPOOL_MAX_TX_FETCH_RETRIES` (5) consecutive `getRawTransactions()` failures the loop breaks, allowing the `finally` to clear the flag and the next tick to retry cleanly.
- `this.lastBlocks` is now sorted by block height (tip last) at both load sites so `verifyReorg()` no longer throws "Can't delete a block from the 'last blocks' if it's not the last one" on every reorg.
- `stopParsing()` now clears and nulls the recurring `mempoolInterval` timer on shutdown to prevent the mempool poll from touching an already-closed database.
- `updateMempool()` post-fetch body is now wrapped in `try/catch/finally` so exceptions from `parseTransaction`, `beginTransaction`, or LevelDB no longer leave `mempoolBusy` stuck `true`.
- Outputs created in a rolled-back block are now deleted from the live UTXO index via a new `W` creation-block reverse index (`[W][blockHash][txHash8][outputIndex]`), eliminating phantom UTXOs and inflated confirmed balances after a reorg.
- Block-time mempool cleanup is now wrapped in a dedicated mempool-DB transaction guarded by the `mempoolBusy` mutex, preventing a concurrent `updateMempool()` from seeing a half-removed transaction view.
- `blockFromBuffer` now strips the Litecoin MWEB marker+flag when the flag is the combined segwit+MWEB value `0x09` as well as the pure-MWEB `0x08`, making the block-level path symmetric with `txFromHex`.

### Removed
- `src/BlockchainConnector.js`: removed unused `getMempoolEntry(txid)` method and its unit test; the tracker's indexing flow never called it and an unexercised RPC wrapper risks silently drifting with coin-node response shape changes.

## [1.0.9] - 2026-05-28

### Security
- Pin `qs` to `^6.15.2` via an `overrides` entry, remediating GHSA-q8mj-m7cp-5q26 (moderate DoS: `qs.stringify` throws on null/undefined entries in comma-format arrays with `encodeValuesOnly` set).

## [1.0.8] - 2026-05-28

### Fixed
- Mempool ingest corrupted the previous-transaction hash in UTXO spend-hint (J) records because `parseTxInputs` reversed each input's hash buffer in place, so subsequent consumers received doubly-reversed bytes; the hash is now reversed on a copy, leaving shared source bytes intact.

## [1.0.7] - 2026-05-28

### Removed
- Unused `mysql` dependency; the service connects via the `mariadb` driver only and the legacy package was never imported.

## [1.0.6] - 2026-04-06

### Changed
- Move coverage badge to its own line in README.md for cleaner formatting

## [1.0.5] - 2026-04-05

### Changed
- `README.md`: rewrote to match platform README structure: added version/test/coverage badges, Features list (15 items), Documentation table linking to xchain-documentation repo, Quick Start with `.env` example, Scripts table (19 commands), Test Suite breakdown (8 categories, 618+ tests), copyright footer
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
- Mempool spend detection, `getInput()` now truncates txid to txHash8 to match key format used by `insertInput()`, fixing broken mempool spend detection in `getBalanceInfo()` and `getUtxosAddress()`

### Added
- Fuzz testing suite with 12 campaigns (P0-P3) using fast-check, covering block decoding, LevelDB encoding, balance calculation, transaction processing, address validation, reorg handling, mempool operations, connector responses, API endpoints, bootstrap filenames, and configuration parsing
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
- **Binary key/value encoding**, replaced hex string keys and values with raw binary encoding, reducing DB size ~50%
- **Reduced txid storage**, txid fields in T, I, J keys reduced to 8 bytes, further shrinking DB footprint
- **Active-UTXO-only storage**, store only unspent outputs instead of all outputs, reducing DB size ~60-70%
- **Concurrent block prefetch**, pre-fetch up to 10 blocks concurrently via JSON-RPC batch requests with HTTP keepAlive, reducing RPC idle time
- **Parallel transaction processing**, inputs and outputs processed concurrently within each transaction using two-pass approach
- **Increased batch sizes**, skip redundant LevelDB reads and use larger batch commits for throughput
- Default mode changed to not delete spent outputs (configurable via `REMOVE_SPENT`)
- Spent outputs now retained for a configurable number of blocks before deletion
- Renamed from `xchain_address_indexer` to `xchain_utxo_tracker`
- API listens on port specified by `API_PORT` environment variable
- Dockerfile creates data directory and conditionally copies `.env`
- bitcoinjs-lib downgraded from 7.0.0 to 6.1.7 for performance; fixed double buffer block hex string

### Fixed
- Range scan key boundary, `rangeEnd` now appends `0xFF` correctly so scans don't miss keys
- Reorg recovery, re-sync `lastBlocks` array and fix stale `startTimeStamp` reference after chain reorganization
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
