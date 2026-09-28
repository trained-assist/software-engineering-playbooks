# Complexity → price estimation — model (v4, base = one working day)

Status: **implemented** (engine + MCP tool + tests). Issue: #41.
Sources: owner directives 2026-09-28 — re-weighting of methodology v3, then the baseline
redefinition (voice 19:28 МСК).
Deterministic engine: `src/complexity/index.js` · MCP tool: `engineering_estimate_complexity`
(`src/mcp-skills/tools/64-complexity.js`) · tests: `tests/complexity-engine.test.js`,
`tests/complexity-tool.test.js` (the executable specification).

## 1. Formula: one working day × multipliers

The baseline is **the cost of one isolated working day** — a task with no large
complications, nothing entangled with other systems, that fits inside a single day. That day
has a price (`baseDayRub`, currently 15 000 ₽, dictated as "пусть будет 15000"). Every
coefficient is an **increaser of that day**, not a separate per-factor fee:

```
day(tier)    = baseDayRub × tierDays(tier)      T0 = 0.5 day, T1 = 1.0 day
K            = K_observability × K_breadth × K_infra × K_realtime × K_arch × K_acceptance
price_dump    = day(tier) × K                   (dumping)
price_comm    = price_dump × 2                  (commercial)
price_good    = price_dump × 2.5                (good)
```

Three prices are **always** produced — dumping ×1, commercial ×2, good ×2.5.

Tiers are expressed in **days relative to the base day**: `T0` = agent/export with no UI =
0.5 day, `T1` = one static interface = 1.0 day. This keeps v3's ratio (T1 = 2 × T0) and fits
the "all isolated, done within a day" framing. Missing/unknown tier → `T0` plus a warning
(the tool answers, it does not throw).

Every number in the model lives in the single `CONFIG` object of
`src/complexity/index.js` — `baseDayRub`, `tierDays`, and all the K. Changing a number is a
one-line edit of that object plus the test expectations that intentionally pin the numbers —
never a change to the logic. This is a requirement, not a style note: the coefficients were
explicitly dictated as "configurable, e.g. ×3 — something like that", i.e. they will be
retuned.

| Factor | Value | Applies when |
|---|---|---|
| `baseDayRub` × `tierDays` | 15 000 ₽ × {T0: 0.5, T1: 1.0} | always (tier) — the baseline day |
| `K_API_CLOSED` | ×3 | `observability.api = 'closed'` — no test endpoint / access not actually granted |
| `K_INFRA_CLOSED` | ×3 | `observability.infra = 'closed'` — infra reachable only in person / via their admins |
| `BREADTH_ONE_EXTRA` / `BREADTH_TWO_EXTRA` | ×1.3 / ×1.4 | +1 / +2 mobile platform beyond web |
| `K_INFRA_MEDIUM` / `K_INFRA_HIGH` | ×1.7 / ×2.0 | deployed-infrastructure complexity (v3, unchanged) |
| `K_REALTIME` | ×2 | realtime/sync requirements (v3, unchanged) |
| `K_ARCH` | ×1.7 | hard architectural boundaries (v3, unchanged) |
| `K_ACCEPTANCE_NOT_AGREED` | ×1.7 | acceptance not agreed in the spec (v3, unchanged) |
| `K_ACCEPTANCE_CLIENT_TASTE` / `K_ACCEPTANCE_EXTERNAL_METRIC` | ×2.89 / ×2.89 | acceptance judges (v3, unchanged) |
| `STOP_THRESHOLD` | K ≥ 5 | stop rule — warning, not a block (§3) |

## 2. The observability axis is primary

Availability of data/observations is the main driver of price, because work done against an
invisible system is work done twice:

- **Closed API** (no test endpoint — an endpoint "someday" is already a risk): ×3.
- **Closed infrastructure** (access only in person or through their admins): ×3.

They are **independent and multiply**: closed API *and* closed infrastructure = ×9. This
deliberately dominates the estimate — time is worth more than money, and a missing test
endpoint means the implementation behind it is likely sloppy and slow to verify.

**Breadth ("how wide") is deliberately small** — it prices platforms, not difficulty:
web = 1.0, web + one mobile platform = 1.3, web + two = 1.4. (v3's `1.7^(N−1)` over
"interfaces + external systems" is retired; see open questions for what that drops.)

`observability.* = 'unknown'` applies **no** multiplier and only raises a warning: the engine
does not guess. If there is no test endpoint, mark it `'closed'` yourself.

## 3. Stop rule (K ≥ 5)

When the total multiplier reaches `STOP_THRESHOLD` (×5), the engine appends a warning:
*propose removing uncertainty before quoting* — pin down the acceptance criteria, get read
access, agree the integration contract. Quoting into that much uncertainty is how a fixed
price becomes a loss. The warning never blocks: pricing remains possible, it is just
negotiation-ready rather than final.

## 4. Input / output (engine and tool)

Input — one plain object (all fields optional; the tool's `inputSchema` mirrors this):

```js
{
  tier: 'T0' | 'T1',            // 0.5 day / 1.0 day of the base day
  observability: { api?: 'closed'|'unknown', infra?: 'closed'|'unknown' },
  platforms?: string[],                       // extra ios/android entries are counted
  infrastructure?: { complexity?: 'low'|'medium'|'high' },
  realtime?: boolean,
  architecturalConstraints?: boolean,
  acceptance?: { notAgreed?: boolean, clientTaste?: boolean, externalMetric?: boolean }
}
```

Output — always a non-empty object (the MCP empty-result contract holds by construction):

```js
{ tier, baseline, factors: {…}, k, prices: { dumping, commercial, good }, warnings: string[] }
```

`baseline` is the tier's day price = `baseDayRub × tierDays[tier]` (15 000 × {0.5, 1.0}) —
the price before any factor; `k` is the product of the applied factors; `prices.dumping =
baseline × k`.

Boundary behaviour: unknown top-level field → `warnings` entry, ignored in the maths (never
silently multiplied); non-array `platforms` → warning, ignored; no `ios`/`android` → breadth
factor absent (not `1.0` noise in `factors`). The engine is pure: no I/O, no clock, no random —
same input, identical output (`tests/complexity-tool.test.js` asserts determinism).

The tests are the specification: `tests/complexity-engine.test.js` (18 fixed cases) and
`tests/complexity-tool.test.js` (the end-to-end scenario through `registry.callTool`).

## 5. Read inside sandbox-driven development (SbDD)

This model does not live apart from the process it prices. The playbooks' own paradigm —
`docs/engineering-playbooks-design-sandbox-driven-development-and-industry-mapping.md` §2 — says agent speed ≈ 1 / time of the
closed loop that runs **without a human**, and grades work on the S0–S5 ladder (S5 a full
autonomous e2e loop, S1 statics only, S0 blind).

That level is a **price/risk input**, not a side note: a feature whose checks only a human
can perform (S0–S1) means a human sits in every loop, the loop is measured in hours or days
instead of seconds, and the quoted day buys less. Practically:

- **S4–S5** (the agent can run and read the loop itself) → the baseline day means what it
  says; quote the model as-is.
- **S0–S2** (a person must launch, observe or judge each iteration) → the day inflates, and
  that is already the honest reading of the multipliers: a *closed API / closed infra* (×3
  each, §2) is exactly the situation where nobody but the customer can close the loop.

So the stop rule (§3) and the observability axis are the model's view of SbDD: high K means
"the loop is broken open and a human is inside it" — remove the uncertainty before quoting
rather than charging for blind iterations.

## 6. Open questions (v3 weaknesses — recorded, not silently "fixed")

These are known and deliberately **not** corrected in this model:

1. **No volume factor.** A one-page landing and a 30-screen product with the same factors get
   the same price. The engine prices shape, not size.
2. **Over-pricing at factor intersections.** Multiplying independent worst-cases overshoots:
   the Renovatio estimate came out at 820k (dumping) against a 241k team estimate. Every
   stacked K is individually justified; their product may not be. The K ≥ 5 stop rule (§3) is
   the only guard so far.
3. **"Closed IPs" → closed API.** The source directive said "закрытые IP" in voice; this was
   interpreted as *closed/inaccessible APIs*. If the intent was network addresses or on-prem
   hosts, the wording of `observability.api` should be revisited.
4. **External systems dropped out of breadth.** v3's "width" counted interfaces *and* external
   systems (CRM, payment providers) in `1.7^(N−1)`; the re-weighted breadth counts only
   platforms (§2). Integrations are now unpriced except through infra/architectural K —
   potential underestimation. External systems in the formula remain an open question, not a bug.
5. **"The final sum that leans on the customer"** (owner's wording, directive 2) — sounds like
   tying the quote to the customer's budget or profile, but the mechanism was never specified.
   It is **not** in the model: no mechanism exists and none was invented. Record it, don't
   guess it.

Reserved multipliers, **not** implemented on purpose (they need a CTO-level judgement):
no data ×1.2–1.3, regulated data ×1.2.

## 7. Not this: requirement-complexity flags (⚪🟢🟡🔴⚫)

`library/step-types.json` → "Флаги сложности требований" and the V/R/S ladders are about **how
many states and branches a feature creates** during planning — a scoping/risk tool for
playbook steps. This document is about **what the work costs** — a pricing tool. Similar word,
different axis: flags do not appear in the price formula and no price appears in a flag.

## 8. Integration point (deliberately not done here)

`trained-assist/freelance-skill` — the specification generator — will consume this estimate
**secondarily** (its specs quote price; they do not compute it). Wiring that up is a separate
following PR; nothing in this repository calls out to the freelance skill.

Risk/go-no-go scoring and specification generation are untouched by this model.

## 9. Known-contract notes

- Not exported in `provider-manifest.json` (parity with the other engineering-native tools —
  deliberate, see issue #41 §2.6).
- `npm run check` includes `node --check src/mcp-skills/tools/64-complexity.js`; the suite runs
  via `npm test`.
