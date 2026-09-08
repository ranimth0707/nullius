<p align="center"><img src="docs/assets/nullius-mark.svg" width="88" alt="Nullius mark"></p>

<h1 align="center">Nullius</h1>

<p align="center"><b>Take nobody's word for it. Not even the exchange's.</b></p>

<p align="center">
<img src="https://img.shields.io/badge/network-BNB%20Smart%20Chain-F0B90B" alt="BNB Smart Chain">
<img src="https://github.com/ranimth0707/nullius/actions/workflows/test.yml/badge.svg" alt="tests">
<img src="https://github.com/ranimth0707/nullius/actions/workflows/watch.yml/badge.svg" alt="watchtower">
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
through public BSC nodes and compares what comes back against what was advertised. Ten checks run
before anything is signed.

| Check | Refuses when |
|---|---|
| Listing | the product is delisted, or its status is unstated |
| Rate type | an APR is being read as though it were a yield |
| Pairing | a liquidity add would draw on an asset the command never named |
| Simulation | the deposit cannot be simulated, or names no contract |
| Identity | the chain says that contract belongs to a different protocol |
| Mutability | one key can replace the code behind the address |
| Value | the simulated deposit loses value before fees |
| Exit | no withdrawal path can be confirmed |
| History | the rate sits far outside the pool's own multi-year record |
| Capacity | the deposit would own more than 5% of the pool |

The listing check is not original. `defi.md` already says an agent must refuse a product with
`investable: false`. The rule is written down, nothing enforces it, and the field is missing from
the listing an agent reads. The other nine checks have no counterpart anywhere in the docs.

Mutability is the one that matters most, and it came last. Confirming a contract calls itself
Venus BNB is worth little if the code behind that name can be swapped tomorrow. The check reads the
EIP-1967 slots and follows upgrade authority to whoever actually holds it, because an admin that is
a timelock is a different proposition from an admin that is one private key. Venus vBNB holds its
own logic and cannot be changed. Lista BNB forwards elsewhere and that target can be moved, though
its authority ends at a timelock.

The pairing check exists because of one line in `defi.md`: *"You name one token; the wallet debits
BOTH."* `lp-add` takes a single token and a single amount, but a pool position needs both sides and
the wallet will not swap for you. Nothing announces the second requirement in advance. Running the
simulation is what drags it into the open.

### When the name cannot be read

`name()` and `symbol()` are optional in ERC20 and plenty of serious contracts skip them. Treating
their absence as unverifiable refused Lista at 1.50%, a protocol holding $731m behind a proxy whose
upgrade authority ends at a timelock with a 24 hour delay, and handed back Venus at 0.07% instead.
Twenty-one times less yield because of a missing optional method is not caution, it is a bad rule.

Identity by name is one route to it, not the only one. So when the name cannot be read, two other
things are asked instead: whether the chain shows the code is either immutable or changeable only
through a timelock, and whether an independent source recognises this protocol and asset at all.
Both hold, and it proceeds with a warning saying the identity was corroborated rather than read.

The distinctions matter more than the rule. An unresolved admin does not corroborate, because not
knowing who holds the key is the exact thing the mutability check exists to flag. A complete
absence of third-party records does not corroborate either, though finding the protocol without
pinning the specific pool does. Which is why Lista at 1.50% now clears, Lista's other BNB product
does not, and Aster does not.

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

The Telegram bot runs a model so it can read plain English, and it does deposit. Those two facts
have to sit together carefully.

`src/baw.js` refuses anything outside a read-only allowlist, and everything the model can reach
goes through it. Depositing lives in `src/execute.js`, which is not reachable that way. It requires
a nonce minted server-side after a preflight came back clear, bound to the person who staged it,
expiring in five minutes and burned before the call goes out. The model never sees a nonce and
cannot produce one.

So the guarantee is not that the model has been told not to spend money. It is that "the model
decided to deposit" is not a state this program has. Seven tests cover exactly that: an unstaged
nonce, a nonce presented by the wrong person, a rejected attempt leaving the intent intact, and the
same nonce refusing to spend twice.

Tap **Show me the trap** in the bot and it plays both sides: a model handed the listing and nothing
else, then the same product put through the checks.

## What the whole surface looks like

`npm run survey` runs the checks across every product rather than one at a time,
which turns a check into a measurement.

Across 122 products on chain 56, all 61 liquidity pools publish a contract
address and none of them is upgradeable, because an AMM pool is immutable by
construction. No lending product publishes an address at all, and of the five
this wallet could reach by simulation, three sit behind proxies holding roughly
$1.2bn between them. One of those ends at a timelock, which is a materially
better answer than a bare key and is graded as such.

So the surface publishes an address for every product whose code cannot change,
and for none of the products whose code can. The ones worth verifying are the
ones you cannot verify until you already hold the asset. The sample of five
lending products is small and the direction is structural rather than incidental.

## The watchtower

Knowing a contract is upgradeable says a deposit could go wrong. It does not say
anything did.

Wasabi Protocol lost $5m on 30 April 2026 not because its vaults sat behind
proxies, which hundreds of protocols do safely, but because the implementation
behind those proxies was replaced at one particular moment. Drift lost $285m the
same way. In both cases the proxy address never changed, so everything checking
by address, including the identity check in this repo, kept reporting that all
was well.

```bash
npm run watch
```

This records what each of the 66 reachable addresses currently forwards to and
says so when that moves. Building the watchlist needs `baw` and is done once;
after that the check is a public RPC read, so it runs in CI on a schedule with no
wallet, no Binance account and no secrets. Each run commits what it saw, which
makes the git history the record: an implementation that changes cannot be
quietly changed back.

There is no timestamp in the committed file, deliberately. With one it would
differ on every pass and the job would commit a new time every four hours whether
or not anything happened, leaving a real change as one commit among hundreds of
empty ones.

## Reading the specification instead of guessing at it

Most of this tool was built by watching what the wallet CLI did and inferring rules from it. That
is how you end up with rules that are almost right. Going back through the published DeFi API
reference and then measuring the CLI against it found four things the inferred version had wrong.

**Refusals were being blamed on the product.** A deposit preview was run against all 144 Earn and
LiquidityPool products on BSC. 101 of the refusals were the wallet not holding the token. One was a
minimum deposit of 1 USDT on a Lista product, which the listing never mentions. 43 were a parameter
this program had failed to supply. None was the product rejecting a deposit. Every one of them had
been reported the same way, as `Simulation refused`, which reads as a finding and almost never was
one. `src/refusal.js` now separates a refusal about the wallet from a refusal about the product,
and only the second counts as evidence.

The error name alone is not enough to do that, because `SERVICE_ERROR` is not a service error. It
is where the CLI puts ordinary business rejections, so a minimum deposit and a missing tick range
both arrive under it. The published table says to branch on the numeric code rather than the
message, but the CLI does not expose those codes, so for that one name the message has to be read.

**Withdrawal speed was never checked.** Lista and Aster hold redemptions for a waiting period
before the funds can be claimed. The listing shows the same shape of row either way: one rate, no
mention of a queue. The highest-yielding USDT product that clears every other check is a Lista
product, so this was not hypothetical. There is now a check for it, and a redeem reports the delay
back rather than saying the money has been withdrawn when it has not.

**Some positions cannot be withdrawn through the API at all.** Position queries cover more
protocols than transaction building does. The extra ones still come back carrying an
`investmentId`, and it does not work. The only way to tell is to look the ID up in the investment
list, which `src/positions.js` now does before offering a withdraw button.

**Binance scores every protocol it lists, and the score is on a different call.** `protocol-info`
returns a security score and six dimension scores including governance strength. None of it appears
near the rate. Aave scores 94.48, Lista 92.83, Venus 92.21, Solv 88.75, and Aster returns null
while sitting in the same list looking identical. That is now a check.

Two smaller things came out of the same pass and are worth recording. Rate types are perfectly
clean across the surface: all 60 Earn products report APY, all 84 pools report APR, with no
exceptions, so the annual figures are compounded on one side and simple on the other. And
`poolAddress` is present on 84 of 84 pools and 0 of 60 Earn products, which confirms on the full
surface a claim this project previously got wrong and had to correct in public.

One discrepancy is worth reporting upstream. The documented behaviour of `preview --action LP-ADD`
against an `Earn` investment is error `40453`. Run against a Lista USDT product with
`investType: Earn` and an empty `lpTokenList`, it instead returns success and builds a lending
deposit, with `--priceRange` silently ignored. Reproduced three times out of three. An agent asking
to open a liquidity position and receiving a lending deposit is not a difference it would notice.

## Attacking it on purpose

`npm run redteam` hands a model every check in full, the live product list, and
one instruction: get past them. Each answer names a product and a mechanism, and
each is then run through the real checks rather than believed.

The first run produced nothing that passed every check, and three claims that
landed on products the tool cannot evaluate at all. That distinction is kept
separate on purpose. A check that fires is a catch. A product that cannot be
assessed is an admission, and counting it as a win would turn every lending
product into a false victory, since none of them publish a contract.

Which is the actual finding, and it agrees with the survey from the other
direction: coverage here is inverted against the risk. Sixty-one immutable pools
can be checked in full. Sixty-one lending products, the ones where upgradeable
proxies live, cannot be checked at all without first holding the asset being
checked.

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
src/survey.js   sweep the whole surface
src/watch.js    the watchtower
src/redteam.js  point a model at the checks
src/serve.js    local dashboard
src/ui.js       dashboard page
src/bot.js      Telegram
test/           32 tests, including the execution guards and two pinned defects
```

Only `execute.js` broadcasts, and only behind a nonce. Everything else reads or simulates.from a separate terminal.

MIT.
