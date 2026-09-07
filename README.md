<p align="center"><img src="docs/assets/nullius-mark.svg" width="88" alt="Nullius mark"></p>

<h1 align="center">Nullius</h1>

<p align="center"><b>Take nobody's word for it. Not even the exchange's.</b></p>

<p align="center">
<img src="https://img.shields.io/badge/network-BNB%20Smart%20Chain-F0B90B" alt="BNB Smart Chain">
<img src="https://img.shields.io/badge/tests-25%20passing-3fb950" alt="25 tests passing">
<img src="https://img.shields.io/badge/broadcasts-never-8b93a7" alt="never broadcasts">
<img src="https://img.shields.io/badge/license-MIT-45616D" alt="MIT license">
</p>

---

> **Binance requires a security check before an agent swaps a token. It requires nothing before an agent deposits your money into a DeFi protocol. Nullius is that missing check, and it refuses more often than it clears.**

Built for the Binance Agent OS Mini Hackathon, Track A, Onchain Workflows.

## Run it

```bash
git clone https://github.com/ranimth0707/nullius.git
cd nullius && npm run judge
```

Five seconds, no wallet, no funds, no API key. It replays a run recorded against BNB Smart Chain
and writes an HTML report into `reports/`.

```text
Venus BNB @ 0.13%
  ✓ Product accepts deposits
  ✓ Simulated without broadcasting
    Would interact with 0xa07c5b74c9b40447a954e1466938b865b6bbea36
  ✓ Contract confirmed on-chain
    Chain reports "Venus BNB" (vBNB), consistent with Venus BNB.
  ✓ Value is conserved
  ✓ Exit path exists
  ✓ Rate is normal for this pool
    0.13% sits at the 14th percentile of 1524 days of record since 2022-07-06.
  ✓ Pool can absorb this deposit

  GO  all clear

1 of 5 cleared preflight.
```

Three ways to use it, all running the same engine:

```bash
npm run scan   # terminal, --type Earn or LiquidityPool
npm run ui     # dashboard at localhost:4173
npm run bot    # Telegram
```

The live modes need the official CLI and a signed-in wallet:

```bash
npm i -g @binance/agentic-wallet
baw auth signin
```

## Why it exists

There is a file called `security.md` in `binance/binance-skills-hub`. It tells an agent what to do
before a swap: audit the token, show the user every risk it found, get an explicit yes. Skipping
any of that quietly is forbidden.

There is no such file for deposits. An agent gets a protocol name and a percentage from
`investment-list`, and that is the whole basis on which it moves money.

Look at what the listing actually gives you. Chain 56 carries 590 products: 61 lending products
that report APY, and 529 liquidity pools that report APR. Both land in the same sortable list. The
lending side has a median of 0.72%. The pools have a median of 196% and a top entry at 16,121%.
An APR on a concentrated-liquidity position is an annualised fee rate. It is not money anyone
receives and it knows nothing about impermanent loss. Sort that combined list by rate and the
first thing you touch is a memecoin pool.

The listing also leaves things out. It never carries `investable`, so a delisted product stays
visible with its rate intact. The highest-paying lending product on the whole chain, Aave V3 FDUSD
at 12.44%, is delisted. You find out when the deposit fails. And on all 61 lending products
`poolAddress` comes back `null`, so nothing in the listing tells you which contract you are about
to enter. Lista alone runs six USDT pools ranging from 1.81% to 34.69%.

## How it works

`defi preview` simulates a deposit without broadcasting it, and the response carries
`feeAndContract.interactWith`. That is the contract the transaction would call, and it appears
nowhere in the listing.

From there Nullius stops asking Binance anything. It calls `name()` and `symbol()` on that address
through public BSC nodes and compares what comes back against what was advertised. Nine checks run
before anything is signed.

| Check | Refuses when |
|---|---|
| Listing | the product is delisted, or its status is unstated |
| Rate type | an APR is being read as though it were a yield |
| Pairing | a liquidity add would draw on an asset the command never named |
| Simulation | the deposit cannot be simulated, or names no contract |
| Identity | the chain says that contract belongs to a different protocol |
| Value | the simulated deposit loses value before fees |
| Exit | no withdrawal path can be confirmed |
| History | the rate sits far outside the pool's own multi-year record |
| Capacity | the deposit would own more than 5% of the pool |

The listing check is not original. `defi.md` already says an agent must refuse a product with
`investable: false`. The rule is written down, nothing enforces it, and the field is missing from
the listing an agent reads. The other eight checks have no counterpart anywhere in the docs.

The pairing check exists because of one line in `defi.md`: *"You name one token; the wallet debits
BOTH."* `lp-add` takes a single token and a single amount, but a pool position needs both sides and
the wallet will not swap for you. Nothing announces the second requirement in advance. Running the
simulation is what drags it into the open.

### Three answers, not two

A product can pass. It can fail. Or it can produce no evidence in either direction, which happens
when a contract implements no `name()` or when the wallet does not hold the asset being tested.

Calling that third case unsafe would be a lie about what was seen. Calling it safe would defeat the
whole exercise. So it is recorded as untested and the deposit is refused anyway. That distinction
is the reason two live protocols are not accused of anything in the output below.

## What a live run found

Screening the BNB-denominated lending products at a $3.81 test deposit, one of five cleared.

Venus BNB passed everything. The chain confirmed the contract as `Venus BNB` / `vBNB`, and its
0.13% sits at the 14th percentile of 1,524 days of record going back to July 2022.

Venus Flux BNB failed. The listing calls it Venus Flux. The contract calls itself
`Fluid Wrapped BNB` (`fWBNB`). Two protocol names, one deposit.

Lista BNB, Aster BNB and Lista's second BNB product were refused without any accusation. Their
contracts hold code but expose no `name()` or `symbol()`, so nothing could be established.

On the pool side, `--type LiquidityPool` screens the other 529. The highest-rate product on the
whole surface, PancakeSwap V3 `BNB-BREW` at 14,651% APR, fails twice over:

```text
! Rate is a fee rate, not a yield
  Reported as APR at 14,651.56%. On a concentrated-liquidity position that is an
  annualised trading-fee rate, not a return received, and blind to impermanent loss.

✗ Deposit also requires a second asset
  Adding 0.002 of the named token also requires 94.005285574988627206 of BREW (BREW),
  which the command never mentions and the wallet does not hold.
```

Asking to add roughly $1.50 of BNB would also have spent 94 BREW. One asset was named. Two would
have left the wallet.

The product that cleared was then deposited into for real:

```text
0x97ef86f6b1c659d0d2efb56577ee1a211615b220e1c8cb8ca57fb739e8676999
block 120222130 · 197,794 gas · status 1
to: 0xa07c5b74c9b40447a954e1466938b865b6bbea36
```

That destination is the address the preflight named and verified before anything was signed.

## The model has no hands

The Telegram bot runs a model so it can read plain English. The model picks which product to look
at. It has no say in whether anything proceeds.

That is not a rule it was asked to follow. `src/baw.js` enforces a read-only allowlist at the
wrapper level, and `defi deposit` is not on it. The model can decide whatever it likes. The call to
move money does not exist in anything it can reach.

Tap **Show me the trap** in the bot and it plays both sides: a model handed the listing and nothing
else, then the same product put through the checks.

## What this does not do

BSC only. The wallet spans seven chains, but `baw defi` answers `This chain is not supported yet`
on every one except 56.

The identity check is a naming check. A contract that names itself honestly has not been audited,
and one that implements no `name()` is not thereby suspect. The exit check is structural: it shows
a withdrawal path is wired up, not that a future exit clears under stress. Impermanent loss is
named and never modelled. Protocol mapping to DefiLlama is maintained by hand, and anything
unmapped is reported as having no independent record rather than quietly waved through.

### Claims that did not survive

Four things were tested during the build and dropped rather than shipped.

That Binance's data is inaccurate. It is not. An apparent 4× discrepancy in TVL turned out to be a
matching error here, because Lista runs six USDT pools and the wrong one was compared. Matched
properly, the two sources agree to three decimal places.

That higher rates correlate with lower verifiability. Bucketed by rate, verification runs 59.4%
under 1%, 30.0% from 1 to 3%, 50.0% from 3 to 6%, and 33.3% above 6%. Not monotonic, and n=3 in
the top bucket. A median-based figure of 24.7× looked convincing and was an artifact of the many
0.00% pools sitting on the verified side.

That it works across seven chains. See above.

That `poolAddress` is null on every product. Only on lending. All 529 pools carry it. The claim
shipped in an early version of the skill PR and was corrected there.

### The matching threshold was measured

Pools are matched on rate agreement alone. TVL is left out on purpose, because the two sources
define it differently and entries routinely agree on rate to three decimals while differing 40 to
80% on TVL.

The distribution of best-match error is bimodal. A cluster at or below 0.042pp, a gap, then a
spread starting at 0.130pp. Any tolerance inside the gap returns the same set: 59.0% at 0.01pp,
68.9% at 0.05pp, 72.1% at 0.10pp, 75.4% at 0.20pp, 83.6% at 1.00pp. The figure used is 0.10pp and
it never appears without its tolerance.

## Layout

```text
src/baw.js      wrapper over the official CLI, reads and simulations only
src/chain.js    independent BSC reads, three-endpoint fallback
src/llama.js    DefiLlama pool matching and per-pool rate history
src/checks.js   the nine checks and the fail-closed verdict
src/report.js   self-contained offline HTML
src/cli.js      scan and check
src/serve.js    local dashboard
src/ui.js       dashboard page
src/bot.js      Telegram
test/           25 tests, two of them pinning defects listed above
```

Nothing here signs or broadcasts. The deposit above was run by hand from a separate terminal.

MIT.
