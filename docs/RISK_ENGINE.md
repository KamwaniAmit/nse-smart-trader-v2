# Risk Engine: Rule Table

**Rules version: `1.0.0`** (`RISK_RULES_VERSION` in `packages/core/src/risk/rules.ts`).

This document is the specification. The code implements exactly this table, and
`packages/core/tests/riskEngine.test.ts` tests every boundary listed here.

## Read this first: what "documented rationale" means here

A risk threshold cannot be *validated* without outcome data, and none exists yet.
So every number below carries an honest **provenance label**:

| Label | Meaning |
|---|---|
| **LEGACY** | Carried unchanged from the legacy LONG VOL configuration (`maxSpreadPct`, `minDte`, `maxDte`, `targetOi`, `targetVolume`, `ivRvUnfavorableRatio`, `strangleQualityFactor`, `MAX_UTILIZATION_PCT`). Those were themselves labelled *research parameters, not calibrated*. |
| **SPEC** | Follows directly from a frozen definition (for example the 1% Required Edge Buffer, or the 2-session safety rule). |
| **STRUCTURAL** | Follows from how the instrument works (for example, a long option's maximum loss is the premium paid). |
| **DEFAULT** | An initial default with **no source in the specification**. It is a proposal, flagged for owner review. |

**Nothing in this table is calibrated.** (Correction recorded during the Phase 1B build: the first draft banded `capitalUtilization` at 35/70 against the allocation, which would have made every maximally-sized trade `HIGH` and contradicted its own rationale. It was corrected to 50/100 before anything was committed.) Every `DEFAULT` and every `LEGACY` value is an
initial proposal. Changing any number requires: a new rules version, an update to this
document, and updated tests. Until the owner approves the table, treat the output as
a transparent, explainable *screen*, not a validated risk model.

## Independence (non-negotiable)

- Risk is a separate output from **Score**, **Expected Net Edge**, **Capital Requirement** and **Opportunity Status**.
- The engine never receives the opportunity Score or Status. Extra keys passed to it are ignored.
- Risk may use the *quality* of Expected Net Edge as **one input** (`expectedNetEdgeQuality`). It never calculates, replaces or overrides Expected Net Edge.
- Risk filtering (`ALL` / `LOW` / `MEDIUM` / `HIGH`) only selects which rows are shown. It never reorders, rescales or changes Score or Expected Net Edge.

## Inputs, units and scoring

Each input is a plain value supplied by the caller. An input that is missing, `null`,
the wrong type, `NaN`, infinite, or out of its valid range is treated as **unavailable**.
The engine never guesses a replacement.

| Input (frozen name) | Unit and definition | Valid range |
|---|---|---|
| `bidAskSpreadQuality` | Combined spread as a percent of combined ask: `(Σask − Σbid) / Σask × 100`, summed over the legs | ≥ 0 |
| `daysToExpiry` | Trading days to expiry, supplied by the caller (no trading calendar exists yet) | integer-valued, ≥ 0 |
| `capitalUtilization` | `lots × totalCapitalRequirement / maxCapitalAllocation × 100` | ≥ 0 |
| `maxLossDefined` | `true` when the maximum loss is known and bounded | boolean |
| `liquidityVolume` | Smallest traded volume across the legs | ≥ 0 |
| `openInterest` | Smallest open interest across the legs | ≥ 0 |
| `contractLiquidity` | Depth ratio: smallest displayed bid/ask quantity across the legs, divided by the order quantity (`lots × lotSize`) | ≥ 0 |
| `expectedNetEdgeQuality` | `Expected Net Edge / premiumRequirement` (net edge per rupee of premium). Both numbers are produced by the strategy layer, not by Risk | any finite number |
| `ivRvRelationship` | `IV / RV20` (both as decimals) | ≥ 0 |
| `rvRegime` | `"RV_ACCELERATING"` or `"RV_DECELERATING"` (frozen RV5 vs RV20 definition) | those two strings |
| `structureType` | `STRADDLE`, `STRANGLE`, `SINGLE_CALL` or `SINGLE_PUT` | those four strings |
| `distanceFromAtm` | Largest `|strike − spot| / spot × 100` across the legs | ≥ 0 |
| `expiryProximity` | Trading sessions until expiry (same caller-supplied number as `daysToExpiry` in v1) | integer-valued, ≥ 0 |
| `premiumRequirement`, `slippageSensitivity`, `dataCompleteness` | **Recorded for audit, not scored in v1** (see "Not scored") | n/a |

### Bands (the rule table)

Points: `LOW = 0`, `MEDIUM = 50`, `HIGH = 100`. A weight of `req` means the input is **required**; `crit` means a `HIGH` is **critical**.

| Input | LOW | MEDIUM | HIGH | Weight | Flags | Provenance and rationale |
|---|---|---|---|---|---|---|
| `bidAskSpreadQuality` | ≤ 2.5 | > 2.5 and ≤ 5 | > 5 | 18 | req, crit | **LEGACY** for 5 (`maxSpreadPct`). **DEFAULT** for 2.5 (half of the legacy tolerance, splitting it into two equal bands). Spread is the direct cost of entering and leaving a premium-paying position. |
| `daysToExpiry` | ≥ 7 and ≤ 30 | ≥ 2 and < 7, or > 30 | < 2 | 14 | req, crit | **LEGACY** for 7 and 30 (`minDte`, `maxDte`). **SPEC** for 2: the frozen forward protocol exits after 2 completed sessions or at expiry, so a position with fewer than 2 sessions left cannot be held through its own safety window. |
| `capitalUtilization` | ≤ 50 | > 50 and ≤ 100 | > 100 | 14 | req, crit | **SPEC** for 100: capital is a gate, and the frozen `numberOfLots = floor(allocation / requirement)` never exceeds the allocation, so more than 100% means the gate is breached. **DEFAULT** for 50 (half). The legacy `MAX_UTILIZATION_PCT` (70%) is a share of *account* capital; V2 has no account-capital input, so it is deliberately **not** used. Because the frozen formula buys the *maximum* affordable lots, a full deployment sits near 100% (MEDIUM); LOW needs a smaller, explicitly requested position. |
| `maxLossDefined` | `true` | n/a | `false` | 8 | crit | **STRUCTURAL**: every Phase 1B structure is premium-paying, so maximum loss is the premium. `false` (undefined loss) is a hard flag. |
| `liquidityVolume` | ≥ 5000 | ≥ 2500 and < 5000 | < 2500 | 8 | | **LEGACY** for 5000 (`targetVolume`). **DEFAULT** for 2500 (half). |
| `openInterest` | ≥ 10000 | ≥ 5000 and < 10000 | < 5000 | 8 | | **LEGACY** for 10000 (`targetOi`). **DEFAULT** for 5000 (half). |
| `contractLiquidity` | ≥ 5 | ≥ 1 and < 5 | < 1 | 4 | crit | **STRUCTURAL** for 1: if the displayed depth is smaller than the order, the order cannot fill at the displayed price. **DEFAULT** for the 5× comfort margin. |
| `expectedNetEdgeQuality` | ≥ 0.05 | > 0 and < 0.05 | ≤ 0 | 10 | | **SPEC** for 0 (Expected Net Edge is already net of the frozen 1% Required Edge Buffer; zero or negative means no edge). **DEFAULT** for 0.05 (5× that buffer, so that edge is clearly larger than the buffer's own uncertainty). |
| `ivRvRelationship` | < 1 | ≥ 1 and < 2 | ≥ 2 | 4 | | **LEGACY** for 2 (`ivRvUnfavorableRatio`). 1 is parity by definition (IV equals RV20). A buyer overpays when implied volatility is far above realized. |
| `rvRegime` | `RV_ACCELERATING` | `RV_DECELERATING` | n/a | 4 | | **SPEC**: frozen regime definition. A long-volatility buyer is favoured by accelerating realized volatility. The regime alone never produces `HIGH`. |
| `structureType` | `STRADDLE` | `STRANGLE`, `SINGLE_CALL`, `SINGLE_PUT` | n/a | 4 | | **LEGACY** direction (`strangleQualityFactor` 0.7 < 1: a strangle needs a larger move). **DEFAULT** placing the single-leg directional structures at `MEDIUM`. |
| `distanceFromAtm` | ≤ 1 | > 1 and ≤ 3 | > 3 | 4 | | **DEFAULT** for both numbers. There is no source in the specification. |

Weights sum to **100** (a test checks this). Rationale for the weights (all **DEFAULT**): execution cost, time-to-expiry
and capital survivability dominate the loss of a premium-paying position, so they carry the most weight. Liquidity
factors are next. Model-dependent factors (IV/RV, regime) carry the least because they depend on estimates.

### Not scored in v1 (and why)

- `premiumRequirement`: an absolute rupee threshold has no source in the specification. Its effect is already inside `capitalUtilization` and `expectedNetEdgeQuality`.
- `slippageSensitivity`: would double-count `bidAskSpreadQuality`. Not populated in v1.
- `dataCompleteness`: not a caller input. The engine derives `riskDataStatus` itself (below).

## Algorithm (deterministic, no randomness, no clock)

1. **Validate** every input. Invalid means unavailable.
2. **Required check.** Required inputs are `bidAskSpreadQuality`, `daysToExpiry` and `capitalUtilization`. If any is unavailable, the result is `riskLevel = null`, `riskScore = null`, `riskDataStatus = INSUFFICIENT`, with a warning naming the missing inputs. **Nothing is guessed.**
3. **Band** each available scored input to LOW / MEDIUM / HIGH.
4. **Weighted score.** `riskScore = Σ(weight × points) / Σ(weight)` over the *available* scored inputs only (weights are re-normalized), rounded to one decimal.
5. **Base level from the score** (equal thirds, **DEFAULT**): `< 34` → LOW, `34 to < 67` → MEDIUM, `≥ 67` → HIGH.
6. **Escalation** (never lowers a level):
   - any **critical** factor banded `HIGH` → overall `HIGH`;
   - `expiryProximity ≤ 1` (expiring today or in the next session) → overall `HIGH`;
   - any other factor banded `HIGH` → overall at least `MEDIUM`.
7. **Data status.** `COMPLETE` when all 12 scored inputs are available. `PARTIAL` when the required inputs are present but some optional scored inputs are missing (a warning lists them). `INSUFFICIENT` per step 2.

`riskScore` stays the weighted score even when escalation raises the level, and the reasons say so.

**Reachability note (a property of the v1 weights, checked by a test).** The largest weighted score reachable *without*
any critical factor being `HIGH` is **63.0**, which is below the 67 cutoff. So in v1 an overall `HIGH` is always
accompanied by a critical `HIGH` factor (or `expiryProximity ≤ 1`). The score-based `HIGH` branch is kept as a defensive rule
so that a future change to the weights cannot silently remove it.

## Worked examples (also used as tests)

**A. LOW.** spread 3.0 (MEDIUM), DTE 8 (LOW), utilization 60 (MEDIUM), maxLossDefined true, volume 6000, OI 12000,
depth 6, edge ratio 0.08 (all LOW), IV/RV 1.5 (MEDIUM), regime accelerating (LOW), STRANGLE (MEDIUM), distance 2 (MEDIUM).
Score = (18×50 + 14×50 + 4×50 + 4×50 + 4×50) / 100 = **22.0** → `LOW`, `COMPLETE`.

**B. HIGH by escalation.** Same as A but spread 6.0 (HIGH, critical).
Score = (18×100 + 14×50 + 4×50 + 4×50 + 4×50) / 100 = **31.0**, which alone is `LOW`, but a critical factor is `HIGH` → `HIGH`.

**C. INSUFFICIENT.** Same as A with `daysToExpiry` missing → `riskLevel = null`, `INSUFFICIENT`.

## Risk filter

`ALL` returns every item, including those whose risk is unknown (`null`). `LOW`, `MEDIUM` and `HIGH` return only items
with exactly that level. **An item with unknown risk is never shown under `LOW`, `MEDIUM` or `HIGH`.** Order is preserved and the input is never modified.

## Entry risk versus current risk

Entry risk is computed once, at confirmation, and stored inside the immutable entry snapshot together with the
inputs used and the rules version. Current risk is recomputed at each monitor update and stored separately. Neither
overwrites the other.

## What this engine deliberately does not do

It does not calculate Expected Net Edge, Score, Expected Move, Implied Move or capital. It does not read a broker,
a clock or any storage. It does not learn or self-adjust.
