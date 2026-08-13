# Contributing to XChain UTXO Tracker

Thanks for considering a contribution. `xchain-utxo-tracker` serves balance and UTXO data that the encoder uses to pick transaction inputs, so correctness takes priority on every commit.

If you're reporting a security issue, **stop here** and read [`SECURITY.md`](./SECURITY.md) instead. Security reports go through a private channel.

---

## Quick links

- Project overview: [`README.md`](./README.md)
- Full component docs: the [`xchain-documentation`](https://github.com/XChain-Platform/xchain-documentation/tree/master/components/utxo-tracker) repository (architecture, configuration, LevelDB key schema, operations)
- Disclosure policy: [`SECURITY.md`](./SECURITY.md)
- License: [`LICENSE.md`](./LICENSE.md) + [`NOTICE.md`](./NOTICE.md) (GNU Affero General Public License v3.0, dual-licensed)

---

## Repo layout in 30 seconds

```
xchain-utxo-tracker/
├── src/                  indexing pipeline: connector, block decoder, LevelDB writes, API
├── test/                 layered suites (unit, integration, e2e, fuzz, chaos, performance, security, boundary, ...)
├── CHANGELOG.md          authoritative version history
├── SECURITY.md           private vulnerability disclosure
└── package.json          scripts + dependencies
```

---

## Setting up

### Prerequisites

- **Node.js 22** exactly. The platform standardizes on Node 22 fleet-wide, and newer majors are not validated against the stack. `engines.node` declares `>=22.0.0`; use 22.
- No compiler toolchain is required for LevelDB: `classic-level` ships prebuilt binaries for Node 22 and `npm install` handles it automatically.
- A coin node (`bitcoind` / `litecoind` / `dogecoind`) for integration and e2e runs. For local work, the `xchain-regtest-miner` plus a regtest stack is the easiest path.

### First-time install

```bash
git clone https://github.com/XChain-Platform/xchain-utxo-tracker.git
cd xchain-utxo-tracker
npm install
```

Create a `.env` (see [`README.md`](./README.md) for the full key list). **Never commit a `.env` or any real credential.** Secrets live only in the local `.env`, loaded at runtime; never hard-code them into source, tests, or scripts.

---

## Running it

```bash
npm run api        # start the tracker and API server (node --max-old-space-size=4096)
```

---

## Tests

The tracker runs a layered suite. Pick the tier that matches your change:

| Tier | Command | Needs external services |
|---|---|---|
| Smoke | `npm run test:smoke` | No |
| Unit | `npm test` | No |
| Boundary | `npm run test:boundary` | No |
| Security | `npm run test:security` | No |
| CI (unit, fast gate) | `npm run ci` | No |
| Integration | `npm run test:integration` | Coin node regtest |
| End-to-end | `npm run test:e2e` | Full stack |
| Fuzz | `npm run test:fuzz` (`:quick` for 100 iterations) | No |
| Performance | `npm run test:perf` | No |
| Chaos | `npm run test:chaos` | No |

Run the no-external-services tiers before every commit; the README documents the full script catalogue. Changes to UTXO accounting, balance math, reorg handling, or the query API should come with fuzz and security coverage, since balance correctness flows directly into encoder-built transactions.

---

## Coding style

- **Plain JavaScript**, no TypeScript. LevelDB access goes through `src/LevelUpDb.js`; the API layer uses Express with helmet.
- **No linter is configured.** Match the style of the surrounding file: naming, structure, and comment density.
- **Comments are rare on purpose.** Don't restate what well-named code already says. Do comment a *why* that isn't obvious: a hidden invariant, a reorg-safety constraint, a workaround with a reference.
- **Never use the em-dash character** in code, comments, or docs. Rewrite the sentence (a comma, colon, or parentheses) instead.
- **Two trailing spaces** on consecutive bold-label markdown lines so CommonMark renders the line break instead of collapsing them.
- **Balance correctness matters.** All amount arithmetic uses BigInt via `satoshiToDecimalString()`; never introduce floating-point into balance or UTXO calculations.
- **Reorg safety matters.** The 10-block undo history and rollback path are load-bearing; changes there need integration test coverage.

---

## Commit messages

Match the existing log style: a concise subject line, then a short body explaining what changed and why.

- Branch off `master` and keep history linear (rebase, don't merge).
- One logical change per commit; don't batch unrelated work.
- **No `Co-Authored-By` trailers.** This is a project policy.
- **Never `--no-verify`.** If a hook fails, fix the cause; don't bypass it.

---

## Pull requests

CI is the smoke + unit gate. Before opening a PR:

1. Run the no-external-services tiers (`npm run ci`, `npm run test:security`) and confirm they pass.
2. Update `CHANGELOG.md` with a terse entry for your change.
3. Make sure `git status` is clean apart from intended changes (no `node_modules/`, no editor leftovers, no `.env`).
4. Open the PR with a clear title and a description of what changed and why.

For non-security bugs, open an issue at <https://github.com/XChain-Platform/xchain-utxo-tracker/issues/new>. For security bugs, see [`SECURITY.md`](./SECURITY.md).

---

Last reviewed: 2026-06-16.
