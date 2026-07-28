<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright © 2025-2026 Dankest, LLC -->

# XChain Platform UTXO Tracker

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.10-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-618%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="Node">
  <img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20e2e%20%7C%20boundary%20%7C%20security%20%7C%20fuzz%20%7C%20chaos%20%7C%20mutation%20%7C%20regression%20%7C%20performance%20%7C%20smoke-brightgreen" alt="Coverage">
</p>

UTXO indexing service for the XChain Platform. Continuously polls cryptocurrency nodes (Bitcoin, Litecoin, Dogecoin) via JSON-RPC, decodes every block, indexes all unspent transaction outputs in LevelDB using compact binary encoding, and serves balance and UTXO queries through REST and JSON-RPC APIs. The encoder depends on this service to find spendable inputs when constructing transactions.

## Features

- **Full UTXO index**: every unspent output indexed by SHA-256 scriptPubKey hash for fast address lookups
- **Compact binary encoding**: 11 LevelDB key prefix types stored as raw binary Buffers, reducing DB size ~50% vs hex strings
- **Truncated txid keys**: 8-byte transaction ID truncations in index keys for further space savings
- **Active-UTXO-only storage**: only unspent outputs in the live index; spent outputs archived temporarily for reorg recovery
- **Real-time mempool tracking**: unconfirmed transactions in a separate in-memory LevelDB, updated every 60 seconds
- **BigInt precision**: JSON-RPC `get_info` returns full-precision balance strings via `satoshiToDecimalString()`; the REST `/balance` endpoint returns a float (use `get_info` when precision matters)
- **Reorg handling**: per-chain undo history (BTC: 12, LTC: 48, DOGE: 120 blocks) with K/M archive records and automatic rollback on chain reorganization; depth overridable via `XCHAIN_UNDO_BLOCKS_<COIN>`
- **Concurrent block prefetch**: up to 10 blocks pre-fetched concurrently via JSON-RPC batch requests with HTTP keep-alive
- **Batch writes**: LevelDB writes batched in groups of 200 blocks with atomic commit
- **Two-pass transaction processing**: outputs inserted before inputs within each block, correctly handling intra-block spends
- **Multi-chain support**: Bitcoin, Litecoin, and Dogecoin on mainnet, testnet, and regtest
- **AuxPoW/HogEx header stripping**: Dogecoin AuxPoW headers and Litecoin HogEx witness flag stripped before block decoding
- **Bootstrap support**: compressed tar archive backup and restore for fast initial sync
- **REST + JSON-RPC API**: dual interface for UTXO queries, balance lookups, address info, and bootstrap operations
- **618 tests**: unit, integration, e2e, boundary, security, fuzz, chaos, mutation, regression, performance, and smoke testing

## Documentation

Full UTXO tracker documentation is available in the [xchain-documentation](https://github.com/XChain-Platform/xchain-documentation/tree/master/components/utxo-tracker) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/utxo-tracker/README.md) | Overview, features, installation, quick start, scripts, dependencies |
| [Architecture](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/utxo-tracker/ARCHITECTURE.md) | Data pipeline position, LevelDB key schema, block processing loop, reorg handling, mempool tracking |
| [Configuration](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/utxo-tracker/CONFIGURATION.md) | Environment variables, internal constants, database paths |
| [Operations](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/utxo-tracker/OPERATIONS.md) | Running, Docker, REST and JSON-RPC API reference, resilience, troubleshooting |

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
> **Pre-migration LevelDB snapshots must be re-indexed.**
> The on-disk output (`O`) record format was extended to carry the full 32-byte
> transaction hash. Records written before that field was added store a zero hash
> instead, which decodes to a missing txid. The tracker cannot derive a valid,
> spendable transaction id from such a record: only the 8-byte key prefix is
> available, and a 16-character prefix is not a usable txid.
>
> If your LevelDB was first populated by a version of the tracker that predates
> the full-hash output format, wipe the data directory and re-sync from the coin
> node before serving address/UTXO queries with the current version. Without a
> re-index, any UTXO drawn from a pre-migration record raises an explicit
> "missing a fullTxHash ... re-index this LevelDB" error on the first spend attempt
> rather than silently producing an invalid transaction. A fresh sync, or any DB
> already synced under the current format, needs no action.

## Metrics and log shipping (optional, off by default)

A Prometheus `/metrics` endpoint and a structured log shim ship with this
service and stay inert unless switched on: with no env set, no route is
registered, no timer starts and no socket opens. Turn the endpoint on with
`METRICS_ENABLED=1` (add `METRICS_TOKEN` to gate the scrape on a reachable
box), and ship logs with `LOG_SHIP_ENABLED=1` plus `LOG_SHIP_URL`. Full
variable list and the exported metric names are in
[`src/observability/README.md`](src/observability/README.md).

The module is vendored byte-identically from xchain-hub . Edit it there
and re-run `xchain-hub/bin/sync-observability.sh`; a local edit fails the
parity gate in `bin/check-observability-parity.js`.

## Scripts

| Command | Description |
|---|---|
| `npm run api` | Start the tracker and API server |
| `npm test` | Unit tests (~247 tests) |
| `npm run test:smoke` | Smoke tests (11 tests) |
| `npm run test:integration` | Integration tests (~131 tests) |
| `npm run test:e2e` | End-to-end tests (33 tests) |
| `npm run test:fuzz` | Fuzz tests (12 campaigns, 1000 iterations each) |
| `npm run test:fuzz:quick` | Quick fuzz (100 iterations) |
| `npm run test:fuzz:deep` | Deep fuzz (10,000 iterations) |
| `npm run test:perf` | Performance tests (36 tests) |
| `npm run test:perf:quick` | Quick performance (small scale) |
| `npm run test:perf:deep` | Deep performance (large scale, 4 GB heap) |
| `npm run test:chaos` | Chaos engineering tests (41 tests) |
| `npm run test:all` | All unit + integration + e2e tests |
| `npm run mutate` | Mutation testing (Stryker Mutator) |
| `npm run mutate:quick` | Quick mutation testing |
| `npm run mutate:p1` | P1 priority mutation testing |
| `npm run mutate:p2` | P2 priority mutation testing |
| `npm run mutate:p3` | P3 priority mutation testing |

## Test Suite

| Type | Tests | Description |
|---|---|---|
| Unit | ~247 | `LevelUpDb.test.js`, `XChainUtxoTracker.test.js`, `BlockchainConnector.test.js`, `api.test.js`, `XChainBlockDecoder.test.js`, `bufferutils.test.js`, `CryptoNetworks.test.js`, `util.test.js`, `boundary.test.js` |
| Integration | ~131 | `core-indexing.test.js`, `reorg.test.js`, `mempool.test.js`, `api-queries.test.js`, `batch-boundaries.test.js`, `boundary.test.js` |
| E2E | 33 | `lifecycle.test.js`, `persistence.test.js`, `reorg.test.js`, `api.test.js`, `mempool.test.js` |
| Smoke | 11 | `smoke.test.js`: module loading, config, API liveness |
| Fuzz | ~119 | 12 campaigns: blockDecoder, txProcessing, connector, addressValidation, balanceCalc, outputEncoding, leveldbKeys, apiEndpoints, bootstrap, config, reorgHandling, mempool |
| Performance | 36 | Indexing throughput, query load, mempool stress, DB growth, reorg under load |
| Chaos | 41 | RPC faults, storage faults, concurrency, state corruption |
| Mutation | (Stryker) | Stryker Mutator: P1/P2/P3 tiers + custom Buffer/encoding mutations |
| **Total** | **618+** | |

---

**Copyright &copy; 2025-2026 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-or-later)
with a commercial license available for proprietary use.

You may use, modify, and distribute this material under the terms of the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
See the [licensing overview](https://docs.xchain.io/legal/LICENSING.html).
