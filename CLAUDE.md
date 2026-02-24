# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install       # Install dependencies
npm run api       # Start the API server (node ./src/api.js)
```

Docker:
```bash
docker-compose up --build   # Build and run in Docker
```

There are no test or lint scripts defined in package.json.

## Environment Configuration

The application is configured entirely via a `.env` file (gitignored). Required variables:

| Variable | Description |
|---|---|
| `NETWORK` | Network identifier (e.g. `bitcoin-mainnet`, `dogecoin-mainnet`, `litecoin-mainnet`) |
| `NODE_URL` | Bitcoin-compatible node RPC host |
| `NODE_PORT` | Node RPC port |
| `NODE_USER` | Node RPC username |
| `NODE_PASSWORD` | Node RPC password |
| `UTXO_TRACKER_API_PORT` | Port for the Express API to listen on |
| `AUX_POW` | Set to truthy if the network uses Auxiliary Proof of Work (e.g. Dogecoin) |

## Architecture

### Data Flow

1. `api.js` reads env vars, instantiates `XChainUtxoTracker`, and calls `tracker.start()` to begin background indexing.
2. `XChainUtxoTracker` continuously polls the coin node via `BlockchainConnector` (JSON-RPC over HTTP using axios), fetching raw block hex one block at a time.
3. Each block is decoded by `XChainBlockDecoder` into a block object with transactions.
4. Every transaction's inputs and outputs are parsed and written to a LevelDB database (`LevelUpStore`) in batches of 100 blocks (`DB_TRANSACTION_BLOCKS_QUANTITY`).
5. Once fully synced, the mempool is refreshed every 60 seconds into a separate in-memory LevelDB instance.
6. The Express API reads from these databases to serve address queries.

### Key Modules

- **`src/api.js`** — Entry point. Sets up Express with REST and JSON-RPC routes. Handles bootstrap (backup/restore) via `pigz` + `pv` + `tar` subprocess pipelines.
- **`src/XChainUtxoTracker.js`** — Core indexer class. Manages the parse loop, reorg detection (`verifyReorg`), mempool updates, and database transaction batching.
- **`src/LevelUpDb.js`** — All database I/O. Uses LevelDB (via `levelup`/`leveldown`) with key prefixes to store blocks (`B`), transactions (`T`), inputs (`I`), outputs (`O`), and hint indexes (`H`, `J`) for efficient lookups. Mempool uses in-memory LevelDB (`memdown`).
- **`src/BlockchainConnector.js`** — Wraps coin node RPC calls (getblock, getblockhash, getrawmempool, getrawtransaction, etc.) via axios.
- **`src/XChainBlockDecoder.js`** — Wraps `bitcoinjs-lib` block/transaction parsing with coin-specific workarounds (Litecoin HogEx transactions, AuxPow stripping for Dogecoin).
- **`src/CryptoNetworks.js`** — Returns `bitcoinjs-lib`-compatible network config objects for Bitcoin (mainnet/testnet/regtest), Dogecoin, and Litecoin.
- **`bufferutils.js`** — A patched replacement for `bitcoinjs-lib/src/bufferutils` that supports `bigint` values in transaction output parsing. The Dockerfile copies this file over the installed library's version.

### Database Key Schema (LevelUpDb)

Outputs are indexed by `scriptPubKey` (SHA-256 of the output script), allowing lookups by address. The tracker converts an address to its output script, hashes it, and scans LevelDB by prefix.

- UTXO detection: All outputs are stored. An output is spent (not a UTXO) if a corresponding input record exists for that `(txid, vout)` pair.
- Reorg handling: The last `UNDO_BLOCKS` (10) blocks are tracked. On reorg, blocks are rolled back one at a time until the chain tip matches the node.

### Supported Networks

`NETWORK` env var accepts: `bitcoin-mainnet`, `bitcoin-testnet`, `bitcoin-regtest`, `dogecoin-mainnet`, `dogecoin-testnet`, `dogecoin-regtest`, `litecoin-mainnet`, `litecoin-testnet`, `litecoin-regtest`.

### AuxPow

When `AUX_POW` env var is set, `BlockchainConnector.getBlockWithoutAuxPow()` is used: it fetches the block header separately, calculates how many extra bytes the AuxPow data added beyond the standard 80-byte Bitcoin header, and strips those bytes from the full block hex before parsing.

### Bootstrap (Backup/Restore)

The `getbootstrap` / `restorebootstrap` JSON-RPC methods stop the parser, then shell out to `tar | pv | pigz` (compress) or `pigz | pv | tar` (decompress) pipelines. Progress is tracked via `pv -n` stderr output. The compressed file embeds the original byte count as a GZIP comment for decompression progress estimation. These system tools (`pigz`, `pv`) must be installed — they are included in the Dockerfile.

### Data Storage Paths (Docker)

- LevelDB data: `/data/xchain-utxo-tracker/`
- Bootstrap files: `/bootstrap/xchain-utxo-tracker/<filename>`
