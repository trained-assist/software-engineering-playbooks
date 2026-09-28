# Complexity → price estimation — model (v4 re-weighting)

Status: **implemented** (engine + MCP tool + tests). Issue: #41.
Source: owner directive 2026-09-28 (re-weighting of methodology v3).
Deterministic engine: `src/complexity/index.js` · MCP tool: `engineering_estimate_complexity`
(`src/mcp-skills/tools/64-complexity.js`) · tests: `tests/complexity-engine.test.js`,
`tests/complexity-tool.test.js` (the executable specification).

## 1. Formula and three prices

```
K           = K_observability × K_breadth × K_infra-complexity × K_realtime × K_arch × K_acceptance
price_dump   = baseline(tier) × K          (dumping)
price_comm   = price_dump × 2              (commercial)
price_good   = price_dump × 2.5            (good)
```

Three prices are **always** produced — dumping ×1, commercial ×2, good ×2.5.

Tiers (baseline for the dumping price): `T0` = agent/export with no UI, `T1` = one static
interface. Missing/unknown tier → `T0` plus a warning (the tool answers, it does not throw).

Every number in the model lives in the single `COEFFICIENTS` object of
`src/complexity/index.js`. Changing a number is a one-line edit of that object plus the test
expectations that intentionally pin the numbers — never a change to the logic. This is a
requirement, not a style note: the coefficients were explicitly dictated as "configurable,
e.g. ×3 — something like that", i.e. they will be retuned.

| Factor | Value | Applies when |
|---|---|---|
| `BASELINE_T0` / `BASELINE_T1` | baseline per tier | always (tier) |
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
  tier: 'T0' | 'T1',
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

Boundary behaviour: unknown top-level field → `warnings` entry, ignored in the maths (never
silently multiplied); non-array `platforms` → warning, ignored; no `ios`/`android` → breadth
factor absent (not `1.0` noise in `factors`). The engine is pure: no I/O, no clock, no random —
same input, identical output (`tests/complexity-tool.test.js` asserts determinism).

The tests are the specification: `tests/complexity-engine.test.js` (17 fixed cases) and
`tests/complexity-tool.test.js` (the end-to-end scenario through `registry.callTool`).

## 5. Open questions (v3 weaknesses — recorded, not silently "fixed")

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
5. **Price anchored to the customer's budget** was mentioned by the owner but never specified —
   no mechanism exists and none was invented.

Reserved multipliers, **not** implemented on purpose (they need a CTO-level judgement):
no data ×1.2–1.3, regulated data ×1.2.

## 6. Not this: requirement-complexity flags (⚪🟢🟡🔴⚫)

`library/step-types.json` → "Флаги сложности требований" and the V/R/S ladders are about **how
many states and branches a feature creates** during planning — a scoping/risk tool for
playbook steps. This document is about **what the work costs** — a pricing tool. Similar word,
different axis: flags do not appear in the price formula and no price appears in a flag.

## 7. Integration point (deliberately not done here)

`trained-assist/freelance-skill` — the specification generator — will consume this estimate
**secondarily** (its specs quote price; they do not compute it). Wiring that up is a separate
following PR; nothing in this repository calls out to the freelance skill.

Risk/go-no-go scoring and specification generation are untouched by this model.

## 8. Known-contract notes

- Not exported in `provider-manifest.json` (parity with the other engineering-native tools —
  deliberate, see issue #41 §2.6).
- `npm run check` includes `node --check src/mcp-skills/tools/64-complexity.js`; the suite runs
  via `npm test`.
