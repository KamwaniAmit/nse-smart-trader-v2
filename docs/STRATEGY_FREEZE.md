# Strategy Freeze (documentation only: nothing here is implemented in Phase 1A)

These definitions are carried over unchanged from the legacy research and must not be modified without explicit project-owner authorization.

## LONG VOL

LONG VOL = BUY CE + BUY PE. Structures: STRADDLE, STRANGLE.

- Entry premium = CE Ask + PE Ask
- Exit premium = CE Bid + PE Bid
- Never use LTP, midpoint, theoretical price, close or any substitute price when a valid bid/ask exists. A missing bid/ask means DATA_INSUFFICIENT, not a substitution.

## Moves and edge

- T = TradingDaysToExpiry / 252
- Expected Move = RV20 × sqrt(T)
- Implied Move = IV × sqrt(T). Alternative implied-move measure = combined premium / spot.
- Gross Edge = (Expected Move ₹ − Implied Move ₹) × Lot Size
- Required Edge Buffer = 1% of premium requirement
- Net Edge = Gross Edge − scalable friction − flat friction − required edge buffer

## Score (total 100)

- IV vs RV20 = 20
- RV momentum = 15
- Liquidity = 15
- Bid/Ask quality = 10
- OI = 10
- Volume = 10
- DTE = 10
- Structure = 10

## Capital

- premiumRequirement = combinedEntryPremium × lotSize
- totalCapitalRequirement = premiumRequirement + entry costs
- numberOfLots = floor(maxCapitalAllocation / totalCapitalRequirement)
- Capital is a gate. It must not disable the scanner universe.

## Status set

QUALIFIED, WATCH, FILTERED, REJECTED, DATA_INSUFFICIENT.

## Independence

Score, Risk and Expected Net Edge are independent outputs. A high score does not imply low risk. Risk is classified by a dedicated Risk Engine (a later phase), never in the UI.
