# Maintainers

This file lists the people responsible for `xchain-utxo-tracker`, what each of them owns, and how to escalate issues that need a human's attention beyond what `CONTRIBUTING.md` and `SECURITY.md` cover.

The XChain Platform is in pre-launch development and ships under a single primary maintainer today. As contributors take on durable responsibility for areas of the codebase, they will be added here. This is a conventional MAINTAINERS file (an open-source norm used by distros and downstream packagers), not an aspirational org chart.

---

## Primary maintainer

| Role | Name | GitHub | Areas |
|---|---|---|---|
| Lead | J-Dog | [@J-Dog](https://github.com/J-Dog) | Everything: UTXO indexing, balance accounting, LevelDB store, reorg handling, API, releases |

Contact:

- General and non-sensitive: open an issue at <https://github.com/XChain-platform/xchain-utxo-tracker/issues>.
- Code of Conduct: `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`).
- Security disclosures: GitHub Private Vulnerability Reporting, or `security@dankest.llc` (per `SECURITY.md`).

---

## Areas of responsibility

Until additional maintainers join, the lead owns every area below. The table is here so a future contributor (or downstream packager) can see what each area entails when scoping a contribution.

| Area | What it covers |
|---|---|
| UTXO and balance accounting | BigInt balance arithmetic, `satoshiToDecimalString()`, two-pass transaction processing, compact binary output encoding (`O` records), the full-txhash field |
| LevelDB store | Key schema (11 prefix types), binary buffer encoding, batch writes (100-block groups), atomic commits (`src/LevelUpDb.js`, `src/db.js`) |
| Block polling and decoding | JSON-RPC polling loop, concurrent block prefetch, `XChainBlockDecoder.js`, AuxPoW (Dogecoin/Litecoin HogEx) header stripping |
| Reorg and desync handling | 10-block undo history (K/M archive records), automatic rollback on chain reorganization, desync detection (`XChainUtxoTracker.js`) |
| Mempool tracking | In-memory LevelDB for unconfirmed transactions, 60-second refresh cycle (`src/XChainUtxoTracker.js`) |
| Address and UTXO query API | REST + JSON-RPC endpoints, SHA-256 scriptPubKey hash lookups, bootstrap backup/restore (`src/api.js`) |
| Tests | The layered suites under `test/` (unit, integration, e2e, smoke, fuzz, chaos, performance, mutation) |
| Documentation | `README`, `SECURITY`, `CODE_OF_CONDUCT`, `CONTRIBUTING`, `MAINTAINERS`, `CHANGELOG` |

---

## Adding a maintainer

A contributor becomes a maintainer when they have:

1. Sustained contribution in a specific area for at least one release cycle (typically 2 to 3 weeks of active work).
2. Reviewed and merged at least three PRs from outside contributors.
3. Demonstrated awareness of the project's conventions: BigInt arithmetic for all balance math (no floating-point), reorg-safe accounting (undo history must be preserved correctly), and Node 22 as the pinned runtime.

Open a PR adding the new maintainer to the table above with their GitHub handle and area(s) of responsibility. The lead approves and merges.

## Removing a maintainer

A maintainer steps down by opening a PR removing their row. The lead also removes a maintainer who has been inactive for six months or who violates the Code of Conduct, after a written notice period.

---

## Escalation paths

If you cannot reach the relevant area maintainer within a reasonable window:

| Situation | Escalate to |
|---|---|
| Active security incident | `security@dankest.llc` (per `SECURITY.md`) |
| Wrong balances or UTXO accounting that could lead to malformed or fund-losing transactions | Open a public issue tagged `security` AND email `security@dankest.llc` |
| Code-of-conduct concern | `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`) |
| PR has been open without review for 14+ days | Comment `@J-Dog` on the PR; if no response within 7 more days, open an issue tagged `governance` with the PR link |

---

## Decision-making

The lead makes final calls on:

- Accounting correctness: any change to balance math, UTXO record format, or reorg/desync handling.
- The LevelDB key schema and encoding format.
- The query API surface.
- Release timing and version policy.
- Adopting a new heavy dependency.
- Code-of-conduct enforcement, and maintainer additions or removals.

Smaller calls (bug fixes, additions within an existing area, documentation, dependency bumps inside an existing minor) go through PR review by the area maintainer.

---

## Cross-project relationships

| Project | Relationship |
|---|---|
| [`xchain-encoder`](https://github.com/XChain-platform/xchain-encoder) | Primary consumer: queries UTXO balances and selects spendable inputs when constructing PSBTs |
| [`xchain-documentation`](https://github.com/XChain-platform/xchain-documentation) | Protocol spec: UTXO tracker architecture, API reference, configuration |
| [`xchain-node`](https://github.com/XChain-platform/xchain-node) | Installs and runs the tracker as a Docker container |
| Coin nodes (`bitcoind` / `litecoind` / `dogecoind`) | The tracker polls these via JSON-RPC; they are upstream projects, not maintained here |

The utxo-tracker maintainer is not automatically a maintainer of those sibling projects. Cross-project changes go through each project's own review process.
