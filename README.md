<p align="center"><img src="docs/assets/nullius-mark.svg" width="88" alt="Nullius mark"></p>

<h1 align="center">Nullius</h1>

<p align="center"><b>Take nobody's word for it — not even the exchange's.</b></p>

<p align="center">
<img src="https://img.shields.io/badge/network-BNB%20Smart%20Chain-F0B90B" alt="BNB Smart Chain">
<img src="https://img.shields.io/badge/tests-25%20passing-3fb950" alt="25 tests passing">
<img src="https://img.shields.io/badge/broadcasts-never-8b93a7" alt="never broadcasts">
<img src="https://img.shields.io/badge/license-MIT-45616D" alt="MIT license">
</p>

---

> **Binance's own agent skill requires a security pre-check before a swap. Before a DeFi deposit it requires nothing at all. This is that missing check — and it refuses more often than it clears.**

Nullius is a deposit gate for Binance Agent OS. It reads the contract a deposit would actually
touch, puts that address to BNB Smart Chain directly, and refuses when the chain's answer doesn't
match what the listing claimed — or when there is no answer at all.

Built for the Binance Agent OS Mini Hackathon · Track A — Onchain Workflows.

## Run it — one command

No wallet, no funds, no API key. About five seconds.

```bash
git clone https://github.com/ranimth0707/nullius.git
cd nullius && npm run judge
```

```text
Recorded run — no wallet, no network, no funds.
Replayed exactly as captured against BNB Smart Chain.

Venus BNB @ 0.13%
  ✓ Product accepts deposits
    Venus BNB — 0.13%, reported TVL $436,835,894.63
  ✓ Simulated without broadcasting
    Would interact with 0xa07c5b74c9b40447a954e1466938b865b6bbea36 — network fee ≈ $0.0089
  ✓ Contract confirmed on-chain
    Chain reports "Venus BNB" (vBNB) — consistent with Venus BNB.
  ✓ Value is conserved
  ✓ Exit path exists
  ✓ Rate is normal for this pool
    0.13% sits at the 14th percentile of 1524 days of record (median 0.30%) since 2022-07-06.
  ✓ Pool can absorb this deposit

  GO  all clear

1 of 5 cleared preflight.
```

An HTML report lands in `reports/`. To run it live against your own wallet:

```bash
npm i -g @binance/agentic-wallet
baw auth signin
node src/cli.js scan --asset BNB --amount 0.005
```

## The problem

`security.md` in `binance/binance-skills-hub` makes a security procedure mandatory before a swap:
audit the target token, present every risk item, get an explicit acknowledgement. Skipping it
silently is forbidden.

No equivalent exists for `defi deposit`. An agent is handed a protocol name and an APY, and that is
the entire basis on which it moves money.

The basis is thinner than it looks. `investment-list` returns `poolAddress: null` on every product
and omits `investable` altogether — so the highest-yielding entry on BSC, Aave V3 FDUSD at 12.44%,
sits at the top of the list and answers `INVESTMENT_NOT_INVESTABLE: this investment product has
been delisted` the moment a deposit is simulated. An agent that sorts by yield picks it first.

One protocol also runs many pools for the same asset at very different rates. Lista's USDT pools
span 1.81% to 34.69%. Nothing in the listing says which one a deposit enters.

## How it works

`defi preview` simulates a deposit without broadcasting it, and the response carries
`feeAndContract.interactWith` — the contract the transaction would call. That address appears
nowhere in the listing.

From there Nullius stops asking Binance anything. It calls `name()` and `symbol()` on that address
through public BSC nodes and compares the answer with what was advertised. Seven checks run before
anything is signed.

| Check | Refuses when |
|---|---|
| Listing | the product is delisted, or its status is unstated |
| Simulation | the deposit can't be simulated, or names no contract |
| Identity | the chain says that contract belongs to a different protocol |
| Value | the simulated deposit loses value before fees |
| Exit | no withdrawal path can be confirmed |
| History | the rate sits far outside the pool's own multi-year record |
| Capacity | the deposit would own more than 5% of the pool |

Verdicts are three-valued. A product can pass, fail a check outright, or produce no evidence in
either direction — a contract that implements no `name()`, an asset the wallet doesn't hold.
Calling that third case unsafe would misstate what was observed; calling it safe defeats the
purpose. It is recorded as untested, and the deposit is refused regardless.

## What a live run found

Screening the BNB-denominated Earn products on BSC at a $3.81 test deposit, **one of five cleared**.

**Venus BNB** passed everything. The chain confirmed the contract as `Venus BNB` / `vBNB`, and its
0.13% sits at the 14th percentile of 1,524 days of record going back to July 2022.

**Venus Flux BNB** failed. The listing calls it Venus Flux; the contract calls itself
`Fluid Wrapped BNB` (`fWBNB`). Two protocol names for one deposit.

**Lista BNB, Aster BNB** and Lista's second BNB product were refused without prejudice. Their
contracts hold code but expose no `name()` or `symbol()`, so nothing could be established either
way.

The cleared deposit was then executed for real:

```text
0x97ef86f6b1c659d0d2efb56577ee1a211615b220e1c8cb8ca57fb739e8676999
block 120222130 · 197,794 gas · status 1
to: 0xa07c5b74c9b40447a954e1466938b865b6bbea36
```

That destination is the address the preflight predicted and verified before anything was signed.

## Limitations

BSC only. The wallet spans seven chains; `baw defi` answers `This chain is not supported yet` on
every one except 56.

The identity check is a naming check. A contract that names itself honestly has not thereby been
audited, and one that implements no `name()` is not thereby suspect. The exit check is structural —
it establishes that a withdrawal path is wired up, not that a future exit clears under stress.
Protocol mapping to DefiLlama is hand-maintained, and unmapped protocols are reported as having no
independent record rather than quietly passed.

The sample is 61 products on one chain. Nothing here generalises beyond it.

### Three claims tested and dropped

**That Binance's data is inaccurate.** It isn't. An apparent 4× TVL discrepancy turned out to be a
matching error here — Lista runs six USDT pools and the wrong one was compared. Matched correctly,
Binance and DefiLlama agree to three decimal places.

**That higher APY correlates with lower verifiability.** Not supported. Bucketed by rate,
verification runs 59.4% under 1%, 30.0% from 1–3%, 50.0% from 3–6%, and 33.3% above 6%. Not
monotonic, and n=3 in the top bucket. A median-based figure of 24.7× looked convincing and was an
artifact of the many 0.00% pools sitting on the verified side.

**That it works across seven chains.** See above.

### The matching threshold was measured, not chosen

Pools are matched on APY agreement alone. TVL is excluded deliberately: the two sources define it
differently, and entries routinely agree on APY to three decimals while differing 40–80% on TVL.

The distribution of best-match APY error is bimodal — a cluster at or below 0.042pp, a gap, then a
spread starting at 0.130pp. Any tolerance inside that gap returns the same set:

| tolerance | verified |
|---|---|
| 0.01pp | 59.0% |
| 0.05pp | 68.9% |
| **0.10pp** (used) | **72.1%** |
| 0.20pp | 75.4% |
| 1.00pp | 83.6% |

The figure is never quoted without its tolerance.

## Layout

```text
src/baw.js      wrapper over the official CLI; read-only and preview calls only
src/chain.js    independent BSC reads, three-endpoint fallback
src/llama.js    DefiLlama pool matching and per-pool APY history
src/checks.js   the seven checks and the fail-closed verdict
src/report.js   self-contained offline HTML
src/cli.js      scan / check
test/           25 tests, including the two defects above as regressions
```

`baw.js` enforces a read-only allowlist at the wrapper level. **No path through this tool signs or
broadcasts a transaction.** The deposit above was run by hand.

MIT.
