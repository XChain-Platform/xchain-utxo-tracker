# Bulk-sync intermediate file format

Binary formats for the 3 streams emitted by `parse-worker` and consumed by `merger`.
All intermediate files are ephemeral — discarded after `loader` + `validate-db` succeed.

**Endianness is hybrid.** Header fields are little-endian for byte-level compatibility
with `dump.js` headers (first 20 bytes are identical layout across all pipeline files).
Record fields are big-endian so that lexicographic byte-sort coincides with numeric sort
— required by the merger's external sort for fields like `height`, `vout`, `value`.
All hashes and scripts are raw bytes (never hex-encoded on disk).

## Naming

```
{stream}-h{FIRST}-h{LAST}.dat

outputs-h00100000-h00199999.dat
spends-h00100000-h00199999.dat
meta-h00100000-h00199999.dat
```

`FIRST`/`LAST` = inclusive block-height range (8 hex digits, zero-padded).
Ranges are globally unique because each dump covers a unique block range
and each parse-worker processes exactly one dump — no worker-id suffix is
needed. 8 hex digits support heights up to ~99,999,999 (~1,900 years at
~52k blocks/year).

## Shared header (64 bytes)

Every `.dat` file starts with this 64-byte header. The first 20 bytes are identical in
layout to `XCHNDMP1` from `dump.js` — any tool that reads the common prefix (magic,
chain, net, version, heights) works across dump and intermediate files.

```
Shared prefix (0..20) — same layout as dump.js
  [0..8]    8   magic          "XCHNOUT1" | "XCHNSPD1" | "XCHNMTA1"
  [8]       1   chain_code     uint8: 1=bitcoin, 2=litecoin, 3=dogecoin
  [9]       1   net_code       uint8: 1=mainnet, 2=testnet, 3=regtest
  [10..12]  2   version        uint16 LE = 1
  [12..16]  4   first_height   uint32 LE
  [16..20]  4   last_height    uint32 LE

Stream-specific tail (20..64)
  [20..28]  8   record_count   uint64 LE  (back-filled on close; 0 while writing)
  [28..32]  4   record_size    uint32 LE  (fixed-record streams; 0 for variable)
  [32..64]  32  reserved       zeroed
```

`record_count` is written last, via a pwrite at offset 20 after all records are flushed.
A file whose count is still 0 at open time signals a crashed/partial worker — re-run
that range. `record_size` documents the fixed record size inline (0 for variable-length
streams like `meta-*.dat`).

## outputs-*.dat  (magic `XCHNOUT1`, record_size = 120)

One record per TxOut in the block range. Coinbases included. Unsorted, append-only.

```
offset   size  field
[0..8]     8   txHash8         first 8B of the containing tx's txid
[8..12]    4   vout            uint32 BE
[12..20]   8   value           uint64 BE (satoshis)
[20..24]   4   height          int32 BE  (always ≥0 in bulk-sync; -1 reserved for mempool)
[24..56]  32   fullTxHash      full 32B txid
[56..88]  32   scriptPubKey    32B sha256(script)  (matches LevelUpDb O-key format)
[88..120] 32   blockHash       containing block hash
```

`blockHash` is included so the merger can emit Z/S records directly from a re-sort of this stream without cross-referencing `meta-*.dat`.

## spends-*.dat  (magic `XCHNSPD1`, record_size = 20)

One record per non-coinbase input. Coinbases produce no record.

```
offset   size  field
[0..8]     8   prevTxHash8     txHash8 of the output being spent
[8..12]    4   prevVout        uint32 BE
[12..20]   8   spenderTxHash8  txHash8 of the spending tx
```

Merger derives both `I` and `J` LevelUpDb keys from this 20-byte record, and uses
`(prevTxHash8, prevVout)` as the join key against `outputs-*.dat`.

## meta-*.dat  (magic `XCHNMTA1`, record_size = 0 — variable length)

Blocks emitted in ascending height order. Each block header is followed immediately
by the txs contained in that block. `blockHash` is implicit context for the tx list
(no redundant per-tx blockHash).

```
Block record (variable — 76 + 8*tx_count bytes):
  [0..4]    height        uint32 BE
  [4..8]    timestamp     uint32 BE
  [8..40]   blockHash     32B
  [40..72]  previousHash  32B
  [72..76]  tx_count      uint32 BE
  [76..]    tx_count × txHash8   (8B each)
```

Reader pattern: read 76 bytes, read `tx_count`, consume `8 * tx_count` more bytes, repeat.
When emitting to merger, the reader carries the current block's `blockHash` as context
and pairs it with each `txHash8` to produce `T`-key records.

## Parse-worker invariants

- **Stateless append-only.** No in-memory dedup, no hashmap, no cancellation. Every
  output → one record in outputs-*.dat. Every non-coinbase input → one record in
  spends-*.dat. Every block/tx → one record/entry in meta-*.dat.
- **No DB lookups.** Workers never read LevelUpDb. They only read `.xdmp` files
  produced by `dump.js`.
- **Reproducible.** Re-running a worker over the same height range produces
  byte-identical output (same record order, same counts).
- **Idempotent per range.** Workers write to `.tmp` files and atomically rename on
  successful close. A crashed worker leaves `.tmp` artifacts that the next run
  overwrites.
- **Embarrassingly parallel.** N workers over disjoint ranges have zero coordination.

## Merger operations (for context)

The merger is where all the sorting and joining happens. Summary of the required
sort orders — each is an external sort over the concatenation of all workers' files
for that stream:

| Target LevelUpDb keys | Sort key                             | Source stream   |
|----------------------|--------------------------------------|-----------------|
| O join cancellation  | `(txHash8, vout)`                    | outputs         |
| spend cancellation   | `(prevTxHash8, prevVout)`            | spends          |
| O (final key order)  | `(scriptPubKey, txHash8, vout)`      | live-utxos      |
| H                    | `(txHash8, vout)`                    | live-utxos      |
| I                    | `(prevTxHash8, prevVout)`            | spends          |
| J                    | `(spenderTxHash8, prevTxHash8, v)`   | spends          |
| S / Z                | `scriptPubKey` then `height`         | outputs (all)   |
| T                    | `txHash8`                            | meta (tx list)  |
| B / N                | `blockHash`                          | meta (blocks)   |
| LAST_BLOCK_{HEIGHT,HASH} | max height                       | meta (blocks)   |

`K` and `M` prefixes are skipped entirely — bulk-sync stops `UNDO_BLOCKS` before the
tip and the regular incremental worker takes over with normal K/M bookkeeping.

## Endianness rationale

**Header fields are LE** to match `dump.js` byte-for-byte on the shared prefix. Headers
are read once per file through explicit field readers — byte order only needs to be
self-consistent, not sort-friendly.

**Record fields are BE** so lexicographic byte-order sort (cheapest for external sort)
coincides with numeric order for `height`, `vout`, `value`. This lets the merger use
plain `memcmp`-style comparators without decoding fields.
