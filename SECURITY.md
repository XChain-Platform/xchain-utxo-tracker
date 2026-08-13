# Security Policy

`xchain-utxo-tracker` indexes all UTXOs from a coin node and serves address and balance queries over a REST and JSON-RPC API (LevelDB-backed). The encoder depends on this service to select spendable inputs when constructing transactions: a wrong or stale balance can lead to a malformed or fund-losing transaction. We treat reports seriously and respond fast.

If you've found a security issue, please **do not open a public issue or pull request**. Use the private channels below.

---

## How to report

### Preferred: GitHub Private Vulnerability Reporting

Open a draft advisory at:

<https://github.com/XChain-Platform/xchain-utxo-tracker/security/advisories/new>

This is the fastest path. The advisory is private until we publish it.

### Alternative: Email

Email **security@dankest.llc** with:

- A description of the issue and the threat it poses.
- Reproduction steps or a proof-of-concept (a crafted query, block, or chain state that triggers the bug).
- The affected version (see `CHANGELOG.md` and the version badge in `README.md`) and the network you tested against (mainnet / testnet / regtest, and which chain).
- Any patches or mitigations you'd like considered.

For sensitive reports, encrypt the email body to our PGP key. The fingerprint will be published alongside the first signed release artifact; until then, the email channel is acceptable for first contact and we will coordinate an encrypted exchange before you share proof-of-concept details.

We do not currently offer a paid bug bounty. We do offer public credit in release notes and the advisory itself, unless you prefer to remain anonymous.

---

## Response timeline

| Stage | Target |
|---|---|
| Initial acknowledgement | within 72 hours |
| Triage + severity assignment | within 7 days |
| Fix or mitigation in master | within 30 days for high/critical, 90 days for lower severities |
| Coordinated public disclosure | up to 90 days from initial report, or sooner if a fix has shipped and operators are protected |

If we cannot meet a timeline, we will tell you why and propose a new one. We will not silently let a report age.

---

## Scope

### In scope

- Correctness of UTXO and balance accounting in `src/` (output indexing, spend tracking, balance aggregation, BigInt arithmetic).
- Reorg and desync handling: the 10-block undo history, rollback logic, and any path where a chain reorganization can leave the index in an inconsistent state that produces wrong balances.
- The address and balance query API (REST and JSON-RPC): injection via query parameters, response correctness, and any path that returns wrong balances to the encoder.
- Denial-of-service or memory exhaustion via crafted queries, large address sets, or abnormal chain data (the service runs with `--max-old-space-size=4096`; unbounded growth is in scope).
- Mempool tracking correctness: unconfirmed outputs in the in-memory LevelDB and any race between mempool state and confirmed-block state.
- Bootstrap backup and restore integrity: a tampered or truncated archive that causes the tracker to serve incorrect state after a restore.
- Any path that returns wrong balances to a caller, since those balances flow directly into transaction construction by the encoder.

### Out of scope

- How the encoder uses the balances it receives (report against `xchain-encoder`).
- Vulnerabilities in the underlying coin node (`bitcoind` / `litecoind` / `dogecoind`); report those to their respective projects.
- Compromise of upstream npm dependencies (we mitigate via audit + review, but a backdoor in a dep is the dep author's incident, though we still want to hear about it).
- Misconfiguration of the operator's own host, LevelDB paths, or network exposure (for example, binding the API to a public interface without a firewall).
- Attacks that require the operator's shell access to the tracker host.

If you are unsure, send the report anyway and we will tell you whether it falls in scope.

---

## What we ask

- Give us a reasonable window to fix before disclosing publicly. The 90-day ceiling is firm; earlier is fine once a fix has shipped and operators are protected.
- Test against `regtest` or `testnet` where possible (the `xchain-regtest-miner` plus a local stack make this easy). Mainnet proofs-of-concept are accepted but should be the minimum needed.
- Do not run automated scanners against shared XChain infrastructure in a way that would impact availability for other operators.
- Do not access data, or attempt to access data, beyond what is needed to demonstrate the issue.

---

## What we will do

- Confirm receipt within the SLA above.
- Keep you informed as triage and remediation proceed.
- Credit you in the advisory and `CHANGELOG.md` entry, on request.
- Coordinate a CVE assignment when the severity warrants it.
- Publish a post-fix advisory describing the issue, the fix, and the affected version range.

---

## Versions covered

We ship security fixes against the latest release on `master`. Older releases are unsupported. The current version is recorded in `CHANGELOG.md` and the badge in `README.md`.

---

Last reviewed: 2026-06-16.
