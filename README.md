<!-- SPDX-License-Identifier: LicenseRef-Dankest-Community -->
<!-- Copyright © 2025 Dankest, LLC -->

# XChain Platform UTXO Tracker

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.4-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-618%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20e2e%20%7C%20fuzz%20%7C%20chaos%20%7C%20mutation%20%7C%20smoke%20%7C%20performance-brightgreen" alt="Coverage">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node">
  <img src="https://img.shields.io/badge/license-Dankest%20Community-orange" alt="License">
</p>

UTXO indexing service for the XChain Platform. Continuously polls cryptocurrency nodes (Bitcoin, Litecoin, Dogecoin) via JSON-RPC, decodes every block, indexes all unspent transaction outputs in LevelDB using compact binary encoding, and serves balance and UTXO queries through REST and JSON-RPC APIs. The encoder depends on this service to find spendable inputs when constructing transactions.

## Features

- **Full UTXO index** — every unspent output indexed by SHA-256 scriptPubKey hash for fast address lookups
- **Compact binary encoding** — 11 LevelDB key prefix types stored as raw binary Buffers, reducing DB size ~50% vs hex strings
- **Truncated txid keys** — 8-byte transaction ID truncations in index keys for further space savings
- **Active-UTXO-only storage** — only unspent outputs in the live index; spent outputs archived temporarily for reorg recovery
- **Real-time mempool tracking** — unconfirmed transactions in a separate in-memory LevelDB, updated every 60 seconds
- **BigInt precision** — all balance calculations use BigInt arithmetic with `satoshiToDecimalString()`, no floating-point
- **Reorg handling** — 10-block undo history (K/M archive records) with automatic rollback on chain reorganization
- **Concurrent block prefetch** — up to 10 blocks pre-fetched concurrently via JSON-RPC batch requests with HTTP keep-alive
- **Batch writes** — LevelDB writes batched in groups of 100 blocks with atomic commit
- **Two-pass transaction processing** — outputs inserted before inputs within each block, correctly handling intra-block spends
- **Multi-chain support** — Bitcoin, Litecoin, and Dogecoin on mainnet, testnet, and regtest
- **AuxPoW block parsing** — Dogecoin and Litecoin HogEx block header stripping
- **Bootstrap support** — compressed tar archive backup and restore for fast initial sync
- **REST + JSON-RPC API** — dual interface for UTXO queries, balance lookups, address info, and bootstrap operations
- **618 tests** — unit, integration, e2e, smoke, fuzz, chaos, performance, and mutation testing

## Documentation

Full UTXO tracker documentation is available in the [xchain-documentation](https://github.com/XChain-platform/xchain-documentation/tree/master/components/utxo-tracker) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-platform/xchain-documentation/blob/master/components/utxo-tracker/README.md) | Overview, features, installation, quick start, scripts, dependencies |
| [Architecture](https://github.com/XChain-platform/xchain-documentation/blob/master/components/utxo-tracker/ARCHITECTURE.md) | Data pipeline position, LevelDB key schema, block processing loop, reorg handling, mempool tracking |
| [Configuration](https://github.com/XChain-platform/xchain-documentation/blob/master/components/utxo-tracker/CONFIGURATION.md) | Environment variables, internal constants, database paths |
| [Operations](https://github.com/XChain-platform/xchain-documentation/blob/master/components/utxo-tracker/OPERATIONS.md) | Running, Docker, REST and JSON-RPC API reference, resilience, troubleshooting |

## Quick Start

```bash
git clone https://github.com/XChain-platform/xchain-utxo-tracker.git
cd xchain-utxo-tracker
npm install
```

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
| Smoke | 11 | `smoke.test.js` — module loading, config, API liveness |
| Fuzz | ~119 | 12 campaigns: blockDecoder, txProcessing, connector, addressValidation, balanceCalc, outputEncoding, leveldbKeys, apiEndpoints, bootstrap, config, reorgHandling, mempool |
| Performance | 36 | Indexing throughput, query load, mempool stress, DB growth, reorg under load |
| Chaos | 41 | RPC faults, storage faults, concurrency, state corruption |
| Mutation | — | Stryker Mutator: P1/P2/P3 tiers + custom Buffer/encoding mutations |
| **Total** | **618+** | |

---

**Copyright &copy; 2025 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **Dankest Community License**
(based on the Apache License 2.0 with additional non-commercial and network-disclosure terms).

You may not use, modify, or distribute this material except in compliance with the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
A full copy of the License is also available at: [https://dankest.llc/license](https://dankest.llc/license)
