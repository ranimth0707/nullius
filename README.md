# defi-preflight

A deposit gate for Binance Agent OS. It reads the contract a DeFi deposit would actually touch,
puts that address to the blockchain directly, and refuses the deposit when the answer doesn't
match what the listing claimed — or when there is no answer at all.

Track A submission, Onchain Workflows.

## Run it

```bash
npm run judge
```

Replays a recorded run against BNB Smart Chain. No wallet, no network, no funds, about five
seconds. An HTML report is written to `reports/`.

Live, against your own wallet:

```bash
npm i -g @binance/agentic-wallet
baw auth signin
node src/cli.js scan --asset BNB --amount 0.005
```

## The gap

Binance ships a mandatory security procedure for swaps in its own agent skill. `security.md` in
`binance/binance-skills-hub` requires the agent to audit the target token, present the risk items,
and get an explicit acknowledgement before a swap is built.

Nothing equivalent exists for `defi deposit`. The listing hands an agent a protocol name and an
APY, and that is the entire basis on which it is expected to move money.

It is a thin basis. `investment-list` returns `poolAddress: null` on every product and omits
`investable` entirely, so a delisted product sits at the top of the list when you sort by yield —
Aave V3 FDUSD at 12.44% is the highest-yielding entry on BSC and returns
`INVESTMENT_NOT_INVESTABLE` the moment a deposit is simulated. One protocol also runs many pools
for the same asset at very different rates; Lista's USDT pools span 1.81% to 34.69%, and nothing
in the listing tells you which one you are about to enter.

## How it works

`defi preview` simulates a deposit without broadcasting it. The simulation response contains
`feeAndContract.interactWith` — the contract address the transaction would call. That address
never appears in the listing.

From there the tool stops asking Binance anything. It calls `name()` and `symbol()` on that
contract through public BSC nodes and compares the answer to what was advertised. Seven checks run
before anything is signed:

| Check | Refuses when |
|---|---|
| Listing | the product is delisted, or its status is unstated |
| Simulation | the deposit can't be simulated, or names no contract |
| Identity | the chain says that contract belongs to a different protocol |
| Value | the simulated deposit loses value before fees |
| Exit | no withdrawal path can be confirmed |
| History | the rate sits far outside the pool's own multi-year record |
| Capacity | the deposit would own more than 5% of the pool |

Verdicts are three-valued, not two. A product can pass, it can fail a check outright, or it can
produce no evidence either way — a contract that implements no `name()`, an asset the wallet
doesn't hold. Calling that third case unsafe would misstate what was observed; calling it safe
defeats the point. It is reported as untested, and the deposit is refused regardless.

## Results

Screening the BNB-denominated Earn products on BSC at a $3.81 test deposit, one of five cleared.

Venus BNB passed everything: the chain confirmed the contract as `Venus BNB` / `vBNB`, and its
0.13% sits at the 14th percentile of 1,524 days of record going back to July 2022.

Venus Flux BNB failed. The listing calls it Venus Flux; the contract calls itself
`Fluid Wrapped BNB` (`fWBNB`). Two protocol names for one deposit.

Lista BNB, Aster BNB and Lista's second BNB product were refused without prejudice — their
contracts hold code but expose no `name()` or `symbol()`, so nothing could be established.

The Venus BNB deposit was then executed for real:

```
0x97ef86f6b1c659d0d2efb56577ee1a211615b220e1c8cb8ca57fb739e8676999
block 120222130 · 197,794 gas · status 1
to: 0xa07c5b74c9b40447a954e1466938b865b6bbea36
```

That destination is the address the preflight predicted and verified before signing.

## Limitations

BSC only. The wallet spans seven chains but `baw defi` answers `This chain is not supported yet`
on every one except 56.

The identity check is a naming check. A contract that names itself honestly has not thereby been
audited, and one that implements no `name()` is not thereby suspect. The exit check is structural:
it establishes that a withdrawal path is wired up, not that a future exit clears under stress.
Protocol mapping to DefiLlama is hand-maintained, and unmapped protocols are reported as having no
independent record rather than quietly passed.

The sample is 61 products on one chain. Nothing here generalises beyond that.

### Discarded during the build

Three claims were tested and dropped rather than shipped.

That Binance's data is inaccurate — it isn't. An apparent 4× TVL discrepancy turned out to be a
matching error here; matched correctly, the two sources agree to three decimal places.

That higher APY correlates with lower verifiability — not supported. Bucketed by rate, verification
runs 59.4% under 1%, 30.0% from 1–3%, 50.0% from 3–6%, and 33.3% above 6%. Not monotonic, and n=3
in the top bucket. A median-based figure of 24.7× looked convincing and was an artifact of the many
0.00% pools sitting on the verified side.

That the tool works across seven chains — see above.

### Matching threshold

Pools are matched on APY agreement alone. TVL is excluded deliberately: the two sources define it
differently, and entries routinely agree on APY to three decimals while differing 40–80% on TVL.

The distribution of best-match APY error is bimodal — a cluster at or below 0.042pp, a gap, then a
spread starting at 0.130pp. Any tolerance inside that gap returns the same set. Verification rates
across the range: 59.0% at 0.01pp, 68.9% at 0.05pp, 72.1% at 0.10pp, 75.4% at 0.20pp, 83.6% at
1.00pp. The figure used is 0.10pp and it is never quoted without its tolerance.

## Layout

```
src/baw.js      wrapper over the official CLI; read-only and preview calls only
src/chain.js    independent BSC reads with three-endpoint fallback
src/llama.js    DefiLlama pool matching and per-pool APY history
src/checks.js   the seven checks and the fail-closed verdict
src/report.js   self-contained offline HTML
src/cli.js      scan / check
```

`baw.js` enforces a read-only allowlist at the wrapper level. No path through this tool signs or
broadcasts a transaction; the deposit above was run by hand.

MIT.
