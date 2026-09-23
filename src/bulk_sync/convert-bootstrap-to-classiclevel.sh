#!/usr/bin/env bash
#*********************************************************************
#
# Copyright © 2025-2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC - https://dankest.llc
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This file is part of XChain Platform. Licensed under the GNU Affero
# General Public License v3.0 or later; see LICENSE.md. A commercial
# license (without AGPL source-disclosure terms) is available -
# contact legal@dankest.llc.
#
#*********************************************************************

#
# convert-bootstrap-to-classiclevel.sh
#
# Convert a legacy RocksDB xchain-utxo-tracker *bootstrap tarball* into a
# classic-level (LevelDB) bootstrap tarball - entirely offline, without
# touching any running tracker. Output restores exactly as the bootstrap a
# from-scratch classic-level resync + `bootstrap create` would produce, with the
# same wrapper members in the same order, in disk-IO time instead of a multi-day
# reparse. It is not byte-identical: tar mtimes and gzip framing differ.
#
# Wrapper format (must match xchain-node BootstrapService create/restore):
#   <bootstrap>.tar.gz  (outer, gzip)
#     ├── bootstrap.json = { format: 1, module, coin, network, height, created }
#     │                    (FIRST, so a restore reads the end height cheaply)
#     ├── data.tar.gz    = gzip of `tar -C <db-dir> .`  (DB files at tar root)
#     └── data.sha256    = "<sha256 of data.tar.gz>  data.tar.gz"
#   restore: tar xzf outer -> verify data.sha256 -> gunzip data.tar.gz | tar xf - -C /data
# DB files sit at the tar root because the producer tars the tracker volume, and
# that volume's root IS the store (mounted at /data/<DB_NAME> in the tracker).
# `height` is read from the converted store's LAST_BLOCK_HEIGHT; a store it cannot
# be read from writes null, which a restore treats as "height unknown". coin and
# network come from BOOTSTRAP_COIN / BOOTSTRAP_NETWORK when set, else null.
#
# Provenance: the output is UNSIGNED. data.sha256 proves the archive is internally
# consistent, not who made it, and no ed25519 signing key belongs in a throwaway
# migration sidecar - so this script deliberately writes no <out>.sig. Both restore
# paths are fail-closed on provenance, so an unsigned archive is REFUSED by default:
#   xchain-node bootstrap restore  -> XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP=0
#   tracker restorebootstrap       -> BOOTSTRAP_RESTORE_ALLOW_UNSIGNED=1
# Sign it on the key-holding host instead where the archive is to be published:
# publish-bootstraps.sh signs with XCHAIN_NODE_BOOTSTRAP_SIGNING_KEY, and refuses to
# ship an archive that has no .sig. Same posture as a locally-taken `getbootstrap`
# snapshot (src/api.js): unsigned, and it says so.
#
# Run INSIDE the migration sidecar (needs rocksdb + classic-level + node + tar + gzip):
#   MIGRATE_JS  path to migrate_rocksdb_to_classiclevel.js
#               (default /XChainUtxoTracker/src/bulk_sync/migrate_rocksdb_to_classiclevel.js)
#   NODE_PATH   must point at the classic-level node_modules (e.g. /opt/cl/node_modules)
#
# Usage:
#   NODE_PATH=/opt/cl/node_modules \
#     convert-bootstrap-to-classiclevel.sh <src-rocksdb-bootstrap.tar.gz> <out-classic-bootstrap.tar.gz> <workdir>
#
# Disk: peak transient ~2x the DB size in <workdir> (e.g. ~300 GB for BTC's 151 GB DB);
# intermediates are deleted as soon as they are consumed.

set -euo pipefail

SRC="${1:?usage: $0 <src-bootstrap.tar.gz> <out-bootstrap.tar.gz> <workdir>}"
OUT="${2:?missing <out-bootstrap.tar.gz>}"
WORK="${3:?missing <workdir>}"
MIGRATE_JS="${MIGRATE_JS:-/XChainUtxoTracker/src/bulk_sync/migrate_rocksdb_to_classiclevel.js}"

sha256() {
    node -e 'const c=require("crypto"),fs=require("fs");const h=c.createHash("sha256");
const s=fs.createReadStream(process.argv[1]);s.on("data",d=>h.update(d));
s.on("end",()=>process.stdout.write(h.digest("hex")));s.on("error",e=>{console.error(e);process.exit(1)});' "$1"
}
log() { echo "[$(date -u +%H:%M:%S)Z] $*"; }

# Print the store's LAST_BLOCK_HEIGHT (a hex string) as a decimal, or nothing.
store_height() {
    node -e 'const { ClassicLevel } = require("classic-level");
(async () => {
    const db = new ClassicLevel(process.argv[1], { createIfMissing: false, keyEncoding: "buffer", valueEncoding: "buffer" });
    let value;
    try { value = await db.get(Buffer.from("LAST_BLOCK_HEIGHT")); } finally { await db.close(); }
    const hex = value === undefined ? "" : value.toString();
    const height = /^[0-9a-f]+$/i.test(hex) ? parseInt(hex, 16) : NaN;
    if (Number.isSafeInteger(height)) process.stdout.write(String(height));
})().catch((e) => { console.error(e.message); process.exit(1); });' "$1"
}

# Write bootstrap.json in the publisher's shape; an empty height is null.
write_meta() {
    node -e 'const [out, height, coin, network] = process.argv.slice(1);
const meta = { format: 1, module: "xchain-utxo-tracker", coin: coin || null, network: network || null,
    height: height === "" ? null : Number(height), created: new Date().toISOString() };
require("fs").writeFileSync(out, JSON.stringify(meta, null, 2) + "\n");' \
        "$1" "$2" "${BOOTSTRAP_COIN:-}" "${BOOTSTRAP_NETWORK:-}"
}

[ -f "$SRC" ] || { echo "FATAL: src not found: $SRC"; exit 1; }
[ -e "$OUT" ] && { echo "FATAL: out already exists, refusing to overwrite: $OUT"; exit 1; }

rm -rf "$WORK"; mkdir -p "$WORK/outer" "$WORK/rocksdb" "$WORK/classic" "$WORK/wrap"

log "[1/7] extract outer archive: $SRC"
tar xzf "$SRC" -C "$WORK/outer"
[ -f "$WORK/outer/data.tar.gz" ] || { echo "FATAL: malformed bootstrap (no data.tar.gz)"; exit 1; }

log "[2/7] verify SOURCE inner checksum (sanity on the input)"
if [ -f "$WORK/outer/data.sha256" ]; then
    want="$(awk '{print $1}' "$WORK/outer/data.sha256")"
    got="$(sha256 "$WORK/outer/data.tar.gz")"
    [ "$want" = "$got" ] || { echo "FATAL: source inner checksum mismatch (want=$want got=$got)"; exit 1; }
    log "  source data.tar.gz checksum OK"
else
    log "  (no data.sha256 in source - skipping input checksum)"
fi

log "[3/7] extract rocksdb DB"
tar xzf "$WORK/outer/data.tar.gz" -C "$WORK/rocksdb"
rm -f "$WORK/outer/data.tar.gz"            # free source inner archive

log "[4/7] convert rocksdb -> classic-level (with built-in key-by-key verify)"
node "$MIGRATE_JS" --src "$WORK/rocksdb" --dst "$WORK/classic"   # exits non-zero on any mismatch
rm -rf "$WORK/rocksdb"                      # free source DB

# Best-effort: a missing height must never fail a finished multi-hour conversion.
height="$(store_height "$WORK/classic")" || height=""
if [ -n "$height" ]; then
    log "  converted store tip height = $height"
else
    log "  WARNING: could not read LAST_BLOCK_HEIGHT; bootstrap.json carries height null"
fi
write_meta "$WORK/wrap/bootstrap.json" "$height"

log "[5/7] re-wrap classic-level DB into data.tar.gz (tar -C classic .)"
tar cf - -C "$WORK/classic" . | gzip > "$WORK/wrap/data.tar.gz"
rm -rf "$WORK/classic"                      # free converted DB (now inside data.tar.gz)

log "[6/7] compute inner checksum -> data.sha256"
h="$(sha256 "$WORK/wrap/data.tar.gz")"
printf '%s  data.tar.gz\n' "$h" > "$WORK/wrap/data.sha256"
log "  data.tar.gz sha256 = $h"

log "[7/7] wrap outer archive -> $OUT"
tar czf "$OUT" -C "$WORK/wrap" bootstrap.json data.tar.gz data.sha256
rm -rf "$WORK/wrap" "$WORK/outer"

ls -la "$OUT"
log "DONE: classic-level bootstrap written to $OUT"
[ -n "$height" ] || log "WARNING: bootstrap.json has no height, so a restore cannot compare the snapshot tip with the coin node (it reads \"height unknown\")."
log "NOTE: this archive is UNSIGNED (no $OUT.sig). Both restore paths are fail-closed on"
log "      provenance, so it is REFUSED by default. Pick one before you restore:"
log "  publish  - sign it on the key-holding host (publish-bootstraps.sh, XCHAIN_NODE_BOOTSTRAP_SIGNING_KEY),"
log "             which is also what lets it be published and advertised at all"
log "  local    - restore it in place, accepting that provenance is unchecked:"
log "               XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP=0 xchain-node bootstrap restore xchain-utxo-tracker <coin> <network>"
log "               (tracker-side restorebootstrap uses BOOTSTRAP_RESTORE_ALLOW_UNSIGNED=1 instead)"
log "Place it in the bootstrap dir first, either way."
