# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- The LevelDB block cache and the heap-flush threshold are now sized from the memory the process may actually use, reading the cgroup limit when one applies, instead of a fixed 4 GiB and 2048 MB.
- The bulk-sync sort budget is derived from that same memory budget instead of a fixed 4096 MB, so a memory-capped tracker no longer hands its own subprocess more memory than the cap allows.
- Startup logs the resolved memory budget, what bound it, and the sizes derived from it.

### Fixed
- A reorg too deep to recover from now names the commands that rebuild the index, instead of advising a resync from the snapshot that may have caused it.

## [0.10.0] - 2026-08-18

### Added
- `GET /status` carries tracker height, node height, lag and synced, so a caller falling back to it from the health POST has something to judge; an unknown tip reports lag as null rather than 0.
- `get_first_seen_status` gives a freshness-aware sibling to `get_first_seen`, making a null from a lagging or halted tracker distinguishable from an address that never appeared.

### Fixed
- The consensus pin is verified at boot, and the bulk-sync environment is validated.
- Code-review round fixes across the tracker (two rounds, 9 files).

### Security
- Raised the brace-expansion and js-yaml dependency floors and the advisory guards that pin them.

## [0.9.0] - 2026-08-14

First release of the XChain Platform release train. Every component in the train
now shares one platform version, so "XChain 0.9.0" names an exact, reproducible
set of software rather than a rough era.

### Changed
- Adopted the platform version stream. This component moves from `1.0.12` to
  `0.9.0`. **The number is lower but the release is newer**: the platform stream
  starts at 0.9.0 for the testnet series, and 1.0.0 is reserved for mainnet.

<!-- ------------------------------------------------------------------------
     Versions BELOW this line are this component's own legacy stream, from
     before the release train. They are kept for history and are NOT comparable
     to the platform versions above: a higher legacy number is an older release.
     ------------------------------------------------------------------------ -->

## [1.0.12] - 2026-08-13

### Added
- A `health` JSON-RPC method exposes lag, synced and halt state so a badly lagging tracker can no longer be certified as a bootstrap source.
- Added a production-scale performance harness that builds a mainnet-size on-disk LevelDB and asserts address-scan and coin-selection results.

### Fixed
- `CORS_ORIGIN` now accepts a comma-separated allowlist matched per-origin instead of echoing a multi-value header no browser accepts.
- Pre-wipe restore aborts now resume instead of failing after the wipe, bootstrap writes a checksum sidecar file, and a dead field was dropped from key derivation.

### Changed
- AuxPoW block-stripping now gates on the coin's declared wire format in the canonical coin registry instead of hardcoded coin-name checks.
- The per-chain reorg undo-blocks table is now single-sourced so the live worker and bulk seeder can no longer drift apart.
- Corrected the bulk-sync reorg-invariant comments and operator log to reflect which archive records are skipped, seeded, and windowed.

### Fixed
- Bootstrap and restore restart paths now route through the same guarded launch helper as the primary boot, so a polling-loop failure rolls back and logs instead of surfacing as a bare unhandled rejection.

## [1.0.11] - 2026-07-16

### Fixed
- Added a key-schema invariant suite pinning binary key layouts, prefix uniqueness, range coverage, and registry completeness against drift.

## [1.0.10] - 2026-06-20

### Added
- Address UTXO lookups now reject outputs with a pre-migration truncated transaction id instead of forwarding it to the encoder.
- The sync-status API now returns a `synced` boolean so callers no longer need to replicate the threshold locally.
- The address REST endpoints now expose mempool readiness via a response header and body field.
- Added an example environment file enumerating every variable the tracker reads.
- The database connection pool now enforces a query timeout to prevent hung connections.
- Added behavior-contract tests for the LevelDB operations the tracker relies on, plus scripts to re-run suites against the real on-disk engine.
- Added an end-to-end test asserting mempool balance reconverges correctly after a stop and restart.

### Changed
- Pinned core crypto and database dependencies to exact versions for a byte-identical dependency tree across nodes.
- Reduced the mempool inter-batch sleep so cumulative sleep no longer exceeds the mempool poll interval on large mempools.
- Block-batch fetches now retry on transient connection timeouts, matching the existing header-fetch retry logic.
- Migrated the storage backend from RocksDB to LevelDB, requiring every deployed node to resync.
- AuxPoW live-sync prefetch now batches block fetches instead of fetching them individually.
- Aligned the database driver version to the range used across the platform.
- Two error-handling paths now log the caught error inline instead of dropping or duplicating it.
- Reorg cleanup now runs its per-transaction deletions in parallel instead of serially.
- Dependency installs are now reproducible via a committed lockfile and a clean-install build step.

### Fixed
- Corrected the Litecoin dust threshold to match its relay policy.
- Closed an unauthenticated memory-exhaustion path in key-pattern lookups with stricter input gates and a hard result ceiling.
- The sync loop now re-polls the chain tip on a fixed interval during catch-up instead of marking sync complete prematurely.
- Reorg cleanup records are now persisted outside the rolled-back transaction so aged-out entries are no longer stranded.
- The block-format detection guard now accepts both supported transaction versions.
- Hash buffers are now copied before reversal, preventing in-place mutation of shared decoded buffers.
- An environment flag is now parsed as an explicit boolean instead of treating any non-empty string as true.
- Reorg verification now hard-aborts when a reorg exceeds the recovery window instead of silently under-counting UTXOs.
- Mempool updates no longer permanently lock after repeated fetch failures; the next cycle now retries cleanly.
- Loaded block lists are now sorted by height so reorg verification no longer throws on out-of-order data.
- Shutdown now clears the mempool poll timer so it can no longer touch an already-closed database.
- Mempool post-fetch handling is now wrapped so a mid-batch exception can no longer leave its lock stuck.
- Outputs from a rolled-back block are now removed from the live UTXO index via a reverse index, eliminating phantom UTXOs after a reorg.
- Block-time mempool cleanup now runs inside its lock, preventing a concurrent update from seeing a half-removed transaction.
- A Litecoin witness-marker strip now also matches a combined flag value, matching the single-transaction decode path.

### Removed
- Removed an unused connector method and its test.

## [1.0.9] - 2026-05-28

### Security
- Pinned a dependency to remediate a moderate denial-of-service advisory.

## [1.0.8] - 2026-05-28

### Fixed
- Fixed mempool ingest corrupting a previous-transaction hash by mutating a shared buffer in place.

## [1.0.7] - 2026-05-28

### Removed
- Removed an unused database driver dependency that was never imported.

## [1.0.6] - 2026-04-06

### Changed
- Moved the coverage badge to its own line in the README for cleaner formatting.

## [1.0.5] - 2026-04-05

### Changed
- Rewrote the README to match the platform structure, with badges, a features list, and scripts and test-suite tables.
- Moved mutation-testing configs and plugins into a dedicated test directory.
- Updated mutation-testing npm scripts to reference the new paths.
- Moved a buffer-utility module into `src/`, updating imports and configs accordingly.

## [1.0.4] - 2026-04-05

### Added
- Added mutation testing with per-priority configs, a quick mode, and an incremental mode.
- Added a custom mutator plugin for endianness and key-prefix byte-swap mutations.
- Added a standalone mutation runner for buffer and encoding mutations.
- Added a dedicated test-runner config for mutation-testing runs.
- Enabled mutation-testing coverage of a module patched via module resolution.

### Changed
- The API entry point now guards its startup call so it can be safely required by test workers.

## [1.0.3] - 2026-04-05

### Added
- Added a chaos-engineering test suite covering persistence, RPC resilience, state corruption, and concurrency.
- Added fault-injection helpers for batch write failure, read latency, state corruption, and forced reorgs.
- Added chaos coverage for batch atomicity, disk-full recovery, crash mid-batch, and mempool flood scenarios.

## [1.0.2] - 2026-04-05

### Added
- Added a performance and load testing suite covering indexing throughput, query load, mempool stress, and reorg performance.
- Added configurable test scale and JSON results export for performance runs.

## [1.0.1] - 2026-04-05

### Fixed
- Fixed broken mempool spend detection caused by a transaction id truncation mismatch between insert and lookup.

### Added
- Added a fuzz-testing suite covering block decoding, encoding, balance calculation, transaction processing, and more.

## [1.0.0] - 2026-04-03

### Added
- Added bootstrap functionality for creating and restoring LevelDB snapshots.
- Added balance and system-info API calls.
- Added Dogecoin block parsing support.
- Added Litecoin block and witness-version-9 mempool transaction handling.
- Added reorg detection and automatic recovery.
- Added a rolling ETA display for sync progress.
- Added license headers and links.

### Changed
- Switched to binary key/value encoding, reducing database size.
- Reduced transaction id storage to shrink the database footprint further.
- Switched to active-UTXO-only storage, reducing database size.
- Added concurrent block prefetching to reduce RPC idle time.
- Parallelized transaction processing within each block.
- Increased batch sizes for throughput.
- Changed the default mode to retain spent outputs for a configurable window before deletion.
- Renamed the service.
- Made the API port configurable.
- Updated the Dockerfile to create a data directory and conditionally copy the environment file.
- Downgraded a core dependency for performance and fixed a related buffer bug.

### Fixed
- Fixed a range-scan boundary bug that could miss keys.
- Fixed stale state after chain reorganization.
- Suppressed unhandled rejections from discarded prefetch promises during reorg.
- Added a null guard for a missing deleted-transaction list.
- Reduced batch size and increased heap to prevent out-of-memory errors on large blocks.
- Fixed incorrect prefix writes for mempool transactions.
- Increased request timeout for prefetch reliability.
- Fixed a null block-hash handling bug for mempool transactions.
- Fixed cleanup timing so spent UTXO backups are actually purged.
- Fixed a crash on missing output hints from older data.
- Fixed a missing-key bug in transaction value lookup.
- Fixed a key-pattern lookup bug.
- Replaced async stream handlers to prevent race conditions.
- Fixed bootstrap progress reporting.
- Fixed BigInt compatibility issues in block header and transaction parsing.
- Fixed reorg crashes on a null or mismatched chain tip.
- The tracker now waits for the coin node to sync before it starts parsing.
- Fixed an incorrect library reference and a variable-name bug.
- Fixed mempool update performance.
