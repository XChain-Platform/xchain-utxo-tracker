# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
