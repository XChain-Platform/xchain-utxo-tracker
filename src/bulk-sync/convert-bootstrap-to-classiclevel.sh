#!/usr/bin/env bash
#
# convert-bootstrap-to-classiclevel.sh
#
# Convert a legacy RocksDB xchain-utxo-tracker *bootstrap tarball* into a
# classic-level (LevelDB) bootstrap tarball — entirely offline, without
# touching any running tracker. Output is byte-for-byte the bootstrap a
# from-scratch classic-level resync + `bootstrap create` would produce, in
# disk-IO time instead of a multi-day reparse.
#
# Wrapper format (must match xchain-node BootstrapService create/restore):
#   <bootstrap>.tar.gz  (outer, gzip)
#     ├── data.tar.gz    = gzip of `tar -C <db-dir> .`  (DB files at tar root)
#     └── data.sha256    = "<sha256 of data.tar.gz>  data.tar.gz"
#   restore: tar xzf outer -> verify data.sha256 -> gunzip data.tar.gz | tar xf - -C /data
#
# Run INSIDE the migration sidecar (needs rocksdb + classic-level + node + tar + gzip):
#   MIGRATE_JS  path to migrate-rocksdb-to-classiclevel.js
#               (default /XChainUtxoTracker/src/bulk-sync/migrate-rocksdb-to-classiclevel.js)
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
MIGRATE_JS="${MIGRATE_JS:-/XChainUtxoTracker/src/bulk-sync/migrate-rocksdb-to-classiclevel.js}"

sha256() {
    node -e 'const c=require("crypto"),fs=require("fs");const h=c.createHash("sha256");
const s=fs.createReadStream(process.argv[1]);s.on("data",d=>h.update(d));
s.on("end",()=>process.stdout.write(h.digest("hex")));s.on("error",e=>{console.error(e);process.exit(1)});' "$1"
}
log() { echo "[$(date -u +%H:%M:%S)Z] $*"; }

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
    log "  (no data.sha256 in source — skipping input checksum)"
fi

log "[3/7] extract rocksdb DB"
tar xzf "$WORK/outer/data.tar.gz" -C "$WORK/rocksdb"
rm -f "$WORK/outer/data.tar.gz"            # free source inner archive

log "[4/7] convert rocksdb -> classic-level (with built-in key-by-key verify)"
node "$MIGRATE_JS" --src "$WORK/rocksdb" --dst "$WORK/classic"   # exits non-zero on any mismatch
rm -rf "$WORK/rocksdb"                      # free source DB

log "[5/7] re-wrap classic-level DB into data.tar.gz (tar -C classic .)"
tar cf - -C "$WORK/classic" . | gzip > "$WORK/wrap/data.tar.gz"
rm -rf "$WORK/classic"                      # free converted DB (now inside data.tar.gz)

log "[6/7] compute inner checksum -> data.sha256"
h="$(sha256 "$WORK/wrap/data.tar.gz")"
printf '%s  data.tar.gz\n' "$h" > "$WORK/wrap/data.sha256"
log "  data.tar.gz sha256 = $h"

log "[7/7] wrap outer archive -> $OUT"
tar czf "$OUT" -C "$WORK/wrap" data.tar.gz data.sha256
rm -rf "$WORK/wrap" "$WORK/outer"

ls -la "$OUT"
log "DONE: classic-level bootstrap written to $OUT"
log "Restore with: xchain-node bootstrap restore xchain-utxo-tracker <coin> <network>  (after placing it in the bootstrap dir)"
