<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright © 2025-2026 Dankest, LLC -->

# XChain Platform UTXO Tracker

<p align="center">
  <img src="https://img.shields.io/badge/version-0.27.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-2%2C035%2B%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="Node">
  <img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20e2e%20%7C%20boundary%20%7C%20security%20%7C%20fuzz%20%7C%20chaos%20%7C%20mutation%20%7C%20regression%20%7C%20performance%20%7C%20smoke-brightgreen" alt="Coverage">
</p>

UTXO indexing service for the XChain Platform. Continuously polls the coin nodes of every supported chain (Bitcoin, Litecoin, and Dogecoin today) via JSON-RPC, decodes every block, indexes all unspent transaction outputs in LevelDB using compact binary encoding, and serves balance and UTXO queries through REST and JSON-RPC APIs. The encoder depends on this service to find spendable inputs when constructing transactions.

## Features

- **Full UTXO index**: every unspent output indexed by SHA-256 scriptPubKey hash for fast address lookups
- **Compact binary encoding**: 11 LevelDB key prefix types stored as raw binary Buffers, reducing DB size ~50% vs hex strings
- **Full txid keys**: every index key that names a transaction carries the whole 32-byte txid (store layout 2), so two transactions that share leading txid bytes never touch each other's records
- **Active-UTXO-only storage**: only unspent outputs in the live index; spent outputs archived temporarily for reorg recovery
- **Native coin history for watched addresses**: `POST /history` answers confirmed history for up to 20 addresses in one request, newest first and paged by one cursor; an address is watched from its first request and its past is rebuilt from the coin node in the background
- **Real-time mempool tracking**: unconfirmed transactions in a separate in-memory LevelDB, updated every 60 seconds
- **BigInt precision**: JSON-RPC `get_info` returns full-precision balance strings via `satoshiToDecimalString()`; the REST `/balance` endpoint returns a float (use `get_info` when precision matters)
- **Reorg handling**: per-chain, per-network undo history (mainnet BTC: 12, LTC: 120, DOGE: 120 blocks; LTC testnet: 5000; other testnets: 120; regtest as mainnet) with K/M archive records and automatic rollback on chain reorganization; depth overridable via `XCHAIN_UNDO_BLOCKS_<COIN>`
- **Concurrent block prefetch**: up to 10 blocks pre-fetched concurrently via JSON-RPC batch requests with HTTP keep-alive
- **Batch writes**: LevelDB writes batched in groups of 200 blocks with atomic commit
- **Two-pass transaction processing**: outputs inserted before inputs within each block, correctly handling intra-block spends
- **Multi-chain support**: Bitcoin, Litecoin, and Dogecoin today on mainnet, testnet, and regtest
- **AuxPoW/HogEx header stripping**: Dogecoin AuxPoW headers and Litecoin HogEx witness flag stripped before block decoding
- **Bootstrap support**: compressed tar archive backup and restore for fast initial sync
- **REST + JSON-RPC API**: dual interface for UTXO queries, balance lookups, address info, and bootstrap operations
- **990+ tests**: unit, integration, e2e, boundary, security, fuzz, chaos, mutation, regression, performance, and smoke testing

## Documentation

Full UTXO tracker documentation is available in the [xchain-documentation](https://github.com/XChain-Platform/xchain-documentation/tree/master/components/utxo-tracker) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/utxo-tracker/README.md) | Overview, features, installation, quick start, scripts, dependencies |
| [Architecture](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/utxo-tracker/architecture.md) | Data pipeline position, LevelDB key schema, block processing loop, reorg handling, mempool tracking |
| [Configuration](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/utxo-tracker/configuration.md) | Environment variables, internal constants, database paths |
| [Operations](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/utxo-tracker/operations.md) | Running, Docker, REST and JSON-RPC API reference, resilience, troubleshooting |

## Quick Start

Requires **Node.js >= 22**.

```bash
git clone https://github.com/XChain-Platform/xchain-utxo-tracker.git
cd xchain-utxo-tracker
npm install
```

> Storage is LevelDB-backed via [`classic-level`](https://github.com/Level/classic-level),
> which ships prebuilt binaries for Node 22. `npm install` needs no compiler
> toolchain or build flags.

Create a `.env` file:

```env
NETWORK=bitcoin-regtest
NODE_URL=127.0.0.1
NODE_PORT=18443
NODE_USER=rpc
NODE_PASSWORD=rpc
UTXO_TRACKER_API_PORT=3000
```

Start the tracker:

```bash
npm run api
```

## Upgrading

> [!IMPORTANT]
> **Store layout 2 requires a rebuild of every older store.**
> Layout 2 keys every txid field on the whole 32-byte txid; earlier releases
> keyed most of them on the first 8 bytes, which let two transactions sharing
> that prefix overwrite or delete each other's outputs. The old keys do not
> hold the full txid, so they cannot be converted in place. On boot, a non-empty
> store with no `LAYOUT_VERSION` record, an older version, an unreadable stamp,
> or a newer version is refused before any chain data is read. The tracker never
> clears or interprets an incompatible store automatically.
>
> - **Rebuild:** stop the tracker, reset its data store, and restart for a full
>   rescan, or run bulk sync into a fresh empty store. The startup error names
>   both choices. Do not load layout 2 keys over the old directory.
> - **Snapshots:** `getbootstrap` snapshots made by an earlier release remain
>   layout 1. Rebuild after restoring one instead of starting the tracker on it.
> - **Bulk sync:** parse streams also carry full txids and use format 2. Existing
>   format 1 parse artifacts must be parsed again before merging.
> - **API:** the `get_utxos` page cursor (`nextCursor` / `X-Next-Cursor`) is now
>   `<64-hex txid>:<vout>`; a cursor issued before the upgrade is rejected with
>   `INVALID_CURSOR`, so a client restarts that walk from the first page.

Native history (`POST /history`) needs no migration: an upgraded or bulk-seeded store
starts with an empty watch list and builds each address's history on its first request.

Bulk sync writes the same full-txid `T`, `X`, and `Y` transaction indexes as
live indexing when the transaction index is enabled, so `get_tx_block` has the
same lookup behavior for bulk-seeded and incrementally indexed history.

## Native history: `POST /history`

Request body (JSON). Only `addresses` is required:

| field | meaning |
|---|---|
| `addresses` | 1 to 20 address strings, counted before duplicates collapse |
| `from_height`, `to_height` | inclusive block-height bounds |
| `from_time`, `to_time` | inclusive block-time bounds (Unix seconds), applied as filters |
| `limit` | rows per address per page, default 100, at most 1000 |
| `cursor` | the `cursor` of the previous page |

The tracker keeps history only for addresses callers ask about. The first request
for an address adds it to a persistent watch list: from then on live indexing writes
its rows, and a background job rebuilds its past by scanning the tracker's own block
source from the address's first-seen height (Bitcoin Core keeps no address index).
The answer never waits for that job; it carries what is known so far.

Response: `transactions` is newest block first, then txid order within a block.
Each entry is `{ txid, height, time, net, addresses: { <address>: { received, sent, net } } }`.
Amounts are base-unit decimal strings, and `net` can be negative. The entry's own
`net` is the sum over the distinct scripts the request named. `cursor` is `null`
on the last page. A page ends where every address has been read, so a transaction
never appears without one of its addresses' shares. `sync` carries the same
freshness fields as `get_utxos`, and the `X-Tracker-Height`,
`X-Tracker-Tip-Hash` and `X-Reorg-Count` headers come with it. A pager restarts
from the first page when `sync.reorg_count` moves. Time bounds are filters, so one
address's scan stops after 2,500 rows, and a page can hold no transactions while its
`cursor` is still set. Keep paging until `cursor` is `null`.

`addresses` maps each requested address to its state:

| `history_status` | meaning |
|---|---|
| `complete` | every row from `history_from_height` (its first-seen height) is present |
| `backfilling` | rows from `history_from_height` (where live indexing took it over) are present; older rows are still being rebuilt |
| `not_watched` | refused a watch slot; `history_refused` says why |
| `unavailable` | the address holds too many open outputs to rebuild this way |

`backfilling` turns `complete` once the job reaches the block where live indexing
took the address over. An address the tracker has never seen is complete as soon
as the sync loop next passes between blocks.

Watching is bounded so the route cannot make the tracker scan for arbitrary
addresses for free. Each source IP (`req.ip`, the per-IP limiter's key) may add
`UTXO_TRACKER_HISTORY_NEW_PER_IP` new addresses an hour (default 200). The list
holds at most `UTXO_TRACKER_HISTORY_WATCH_MAX` addresses (default 100000). An
address refused because the list is full (`WATCH_LIST_FULL`) is refused to every
caller, and one refused for a spent budget (`IP_BUDGET`) to that IP only, for
`UTXO_TRACKER_HISTORY_COOLDOWN_SECONDS` (`COOLDOWN`, default 600). The list has no
eviction: a watched address stays watched.
At most `UTXO_TRACKER_HISTORY_BACKFILL_CONCURRENCY` backfill passes run at once
(default 1). A pass rebuilds up to 20 addresses together, 10 blocks per chunk with
a pause after each, and yields between blocks. The explorer sends no client address
to the tracker today, so behind it every wallet shares the explorer's one per-IP
budget: a pass-through should keep its own per-client budget (as it does for
`/info`), or forward the client in `X-Forwarded-For` with
`UTXO_TRACKER_TRUST_PROXY_HOPS=1` on the tracker. Before the tracker has indexed
any block, the route answers 503 `NOT_READY`.

Refusals answer 400 with `{ error, code }`. The codes are `INVALID_ADDRESSES`,
`TOO_MANY_ADDRESSES`, `INVALID_ADDRESS`, `INVALID_CURSOR` and `BAD_REQUEST`.

## Metrics and log shipping (optional, off by default)

A Prometheus `/metrics` endpoint and a structured log shim ship with this
service and stay inert unless switched on: with no env set, no route is
registered, no timer starts and no socket opens. Turn the endpoint on with
`METRICS_ENABLED=1` (add `METRICS_TOKEN` to gate the scrape on a reachable
box), and ship logs with `LOG_SHIP_ENABLED=1` plus `LOG_SHIP_URL`. Full
variable list and the exported metric names are in
[`src/observability/README.md`](src/observability/README.md).

The module is vendored byte-identically from xchain-hub. Edit it there
and re-run `xchain-hub/bin/sync-observability.sh`; a local edit fails the
parity check CI runs across the vendored copies.

### Shim controls, and the defaults in force

These four names configure the shim itself. The fleet deploy path carries them
into the container: `xchain-node` forwards any of them set in the module config
store or in the deploy host's environment (`ModuleService.resolveObservabilityEnv`),
and the validator compose files name them outright. Nothing is fabricated when
neither source sets one, so these defaults hold on an unconfigured box:

| Variable | Default | Effect |
|---|---|---|
| `LOG_LEVEL` | `info` | Lowest level emitted. `debug` \| `info` \| `warn` \| `error`; an unrecognised value falls back to `info`. |
| `LOG_FORMAT` | `text` | `text` emits `<iso-ts> <level> [<service>] <msg> key=value`; `json` emits one NDJSON record per line. |
| `METRICS_ENABLED` | `false` | Registers the `/metrics` route. The counter registry is built either way, so counters are collected whether or not the route is exposed. |
| `XCHAIN_LOG_PATCH` | `1` | Routes bare `console.*` calls through the shim so they carry the level and service prefix. `0` leaves `console` untouched, which is what the test bootstrap sets. |

## Scripts

| Command | Description |
|---|---|
| `npm run api` | Start the tracker and API server |
| `npm test` | Unit tests (~1,355 tests) |
| `npm run test:smoke` | Smoke tests (9 tests) |
| `npm run test:integration` | Integration tests (~76 tests) |
| `npm run test:e2e` | End-to-end tests (~36 tests) |
| `npm run test:boundary` | Boundary condition tests (~29 tests) |
| `npm run test:security` | Security tests (~85 tests) |
| `npm run test:regression` | Regression tests (~265 tests) |
| `npm run test:fuzz` | Fuzz tests (13 campaigns, 1000 iterations each, 106 tests) |
| `npm run test:fuzz:quick` | Quick fuzz (100 iterations, 106 tests) |
| `npm run test:fuzz:deep` | Deep fuzz (10,000 iterations, 106 tests) |
| `npm run test:perf` | Performance tests (~32 tests) |
| `npm run test:perf:quick` | Quick performance (small scale, 32 tests) |
| `npm run test:perf:deep` | Deep performance (large scale, 4 GB heap, 32 tests) |
| `npm run test:chaos` | Chaos engineering tests (~31 tests) |
| `npm run test:all` | All unit + integration + e2e tests (1,866 tests) |
| `npm run mutate` | Mutation testing (Stryker Mutator) |
| `npm run mutate:quick` | Quick mutation testing |
| `npm run mutate:p1` | P1 priority mutation testing |
| `npm run mutate:p2` | P2 priority mutation testing |
| `npm run mutate:p3` | P3 priority mutation testing |

## Test Suite

| Type | Tests | Description |
|---|---|---|
| Unit | ~544 | `level_up_db.test.js`, `xchain_utxo_tracker.test.js`, `blockchain_connector.test.js`, `api.test.js`, `xchain_block_decoder.test.js`, `bufferutils.test.js`, `crypto_networks.test.js`, `util.test.js`, `boundary.test.js` |
| Integration | ~69 | `core_indexing.test.js`, `reorg.test.js`, `mempool.test.js`, `api_queries.test.js`, `batch_boundaries.test.js`, `boundary.test.js` |
| E2E | ~36 | `lifecycle.test.js`, `persistence.test.js`, `reorg.test.js`, `api.test.js`, `mempool.test.js` |
| Smoke | 9 | `smoke.test.js`: module loading, config, API liveness |
| Boundary | ~20 | `confirmations.test.js`, `key_range_scan.test.js`, `varint_thresholds.test.js` |
| Security | ~27 | `address_validation.test.js`, `concurrency_gate.test.js`, `key_pattern_injection.test.js`, `rest_route_surface.test.js` |
| Fuzz | ~105 | 13 campaigns: blockDecoder, txProcessing, connector, addressValidation, balanceCalc, outputEncoding, leveldbKeys, apiEndpoints, bootstrap, config, reorgHandling, mempool, keySchema |
| Regression | ~120 | Curated critical-path suite: bulk-sync chain continuity/coinbase/merkle/resume, reorg/undo-window, coinbase maturity, connector cred scrub, satoshi precision |
| Performance | ~29 | Indexing throughput, query load, mempool stress, DB growth, reorg under load, mainnet-scale queries |
| Chaos | ~31 | RPC faults, storage faults, concurrency, state corruption |
| Mutation | (Stryker) | Stryker Mutator: P1/P2/P3 tiers + custom Buffer/encoding mutations |
| **Total** | **990+** | |

---

**Copyright &copy; 2025-2026 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-or-later)
with a commercial license available for proprietary use.

You may use, modify, and distribute this material under the terms of the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
See the [licensing overview](https://docs.xchain.io/legal/LICENSING.html).
