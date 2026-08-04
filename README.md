# Fintech Feed Latency Monitor — Data Quality Algorithm

> A canonical, well-specified, **cross-language (Python + TypeScript)** reference
> implementation of feed-latency measurement with **explicit clock ownership**. Latency
> is a subtraction, and subtraction assumes both timestamps came off the same clock — in
> a market-data path they never do. So the clock profile is a required argument, the
> attested uncertainty bound travels with every reading, and a reading whose true value
> straddles a threshold comes back **`threshold_uncertain`** rather than being rounded to
> a pass. Nothing is clamped: a negative latency is reported as evidence about your
> clocks, not corrected to zero.

<p>
  <img alt="Python" src="https://img.shields.io/badge/python-3.10%2B-blue">
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.7%2B-3178c6">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="Tests" src="https://img.shields.io/badge/tests-112%20py%20%2F%20117%20ts-brightgreen">
</p>

**📖 Full article (canonical):** **[Feed Latency Monitor — The Fintech Builder](https://thefintechbuilder.com/market-data-engineering/data-quality/feed-latency-monitor/)**

This repository is the runnable, production-oriented companion to that article.
The article teaches the concept; this repo is the code you install and build on.

🧭 **Browse all algorithms:** [Awesome FinTech Algorithms](https://github.com/IslamBaraka90/Fintech-Algorithms-Awesome) — the full index of the library.
🗂️ **This algorithm's domain:** [Market Data Engineering](https://thefintechbuilder.com/domains/market-data-engineering/) › **Data Quality**
📥 **Just want to call it?** It also ships in the [`fintech-algorithms`](https://www.npmjs.com/package/fintech-algorithms) npm package — see [Two ways to use this](#two-ways-to-use-this).

| | |
|---|---|
| **Catalog topic** | `D01-F04-A02` |
| **Domain** | D01 — Market Data Engineering |
| **Family** | D01-F04 — Data Quality |
| **Difficulty** | 3 / 5 |
| **Languages** | Python, TypeScript |

---

## Table of contents

- [The mistake this prevents](#the-mistake-this-prevents)
- [Seven statuses](#seven-statuses)
- [`threshold_uncertain`, and why it matters](#threshold_uncertain-and-why-it-matters)
- [Nothing is corrected](#nothing-is-corrected)
- [Two ways to use this](#two-ways-to-use-this)
- [Install](#install)
- [Quickstart](#quickstart)
- [Worked example (exact)](#worked-example-exact)
- [SLO: can you measure it, and does it hold?](#slo-can-you-measure-it-and-does-it-hold)
- [Row shapes](#row-shapes)
- [API reference](#api-reference)
- [Edge cases & limitations](#edge-cases--limitations)
- [Testing](#testing)
- [Related algorithms](#related-algorithms)
- [License](#license)

---

## The mistake this prevents

Latency is a subtraction. Subtraction assumes both numbers came off the same clock.

In a market-data path, they do not:

| Timestamp | Stamped by |
|---|---|
| `event_time` | the **venue** |
| `receive_time` | **your** NIC or capture card |
| `process_time` | **your** feed handler |

Subtracting the venue's clock from yours does not measure transport latency. It measures
transport latency **plus the offset between two clocks you do not jointly control**. If
those clocks are 3ms apart, every "1ms" reading is really somewhere between −2ms and
4ms, and a dashboard reporting 1ms is reporting a number nobody can substantiate.

So the clock profile is a required argument, not a configuration nicety. It names who
owns each timestamp, whether the domains are synchronized, and — the part everything
hinges on — `max_abs_offset_ms`, the attested bound on that offset.

A profile claiming `synchronized` with **no** bound is rejected outright. "The clocks are
in sync" without a number is a belief, not a measurement, and every latency figure
derived from it inherits that.

---

## Seven statuses

| `status` | Meaning | Enters the summary |
|---|---|---|
| `ok` | Below the warning threshold | ✅ |
| `warning` | At or above warning, below critical | ✅ |
| `critical` | At or above critical | ✅ |
| `threshold_uncertain` | The true value straddles a threshold | — |
| `clock_error_negative_latency` | Arrived before it was sent | — |
| `clock_untrusted` | The profile cannot support a verdict | — |
| `processing_order_error` | Your own two timestamps are out of order | — |

The ladder is ordered by which problem **owns** the reading. A reversed consumer
timestamp is reported as `processing_order_error` even when the transport number also
looks bad, because fixing the latency would not fix it — and both of those stamps came
off the *same* clock, so it cannot be a sync problem.

---

## `threshold_uncertain`, and why it matters

Your warning threshold is 5ms. Your clock bound is ±0.05ms. You observe 5.02ms.

```
observed  4.50ms  true value in [4.45, 4.55]  -> ok
observed  5.02ms  true value in [4.97, 5.07]  -> threshold_uncertain
observed  6.00ms  true value in [5.95, 6.05]  -> warning
```

The middle reading brackets the threshold. **You did not pass. You did not fail. You
cannot tell.**

Rounding that to `ok` is the single most common way a latency SLO reports compliance it
never measured — and it is silent, because the number looks perfectly ordinary. Every
event carries `transport_lower_bound_ms` and `transport_upper_bound_ms` so the
uncertainty travels with the value instead of being discarded at the first aggregation.

---

## Nothing is corrected

**A negative transport latency is reported, not clamped.** An event arriving before it
was sent is impossible, so the reading is evidence about your *clocks* — and clamping it
to zero destroys exactly the evidence you need to diagnose them.

**Percentiles are computed over eligible events only.** A feed whose clocks are
untrustworthy produces a summary of `None` rather than a reassuring number. That is the
honest choice, and [`slo_report`](#slo-can-you-measure-it-and-does-it-hold) is how you
deal with the events the summary had to leave out.

---

## Two ways to use this

**📥 The fast path — one call, TypeScript only:**

```bash
npm install fintech-algorithms
```

```ts
import { monitor } from "fintech-algorithms/market-data-engineering/data-quality/feed-latency-monitor";
```

That package is the breadth option: 271 algorithms, one install, the tutorial-level
kernel for each.

**🔬 This repo — the depth option.** Python *and* TypeScript, the `slo` surface
(measurability, undecidable verdicts, clock-error impact, transport/processing split),
microsecond-precision parsing, and 229 tests pinning both languages to one shared
fixture of 180 events.

---

## Install

**Python** (3.10+, no dependencies):

```bash
git clone https://github.com/IslamBaraka90/Fintech-Feed-Latency-Monitor-Data-Quality-algorithm.git
cd Fintech-Feed-Latency-Monitor-Data-Quality-algorithm/python
pip install -e ".[dev]"
```

**TypeScript** (Node 20+, no runtime dependencies):

```bash
cd Fintech-Feed-Latency-Monitor-Data-Quality-algorithm/typescript
npm install
npm run build
```

---

## Quickstart

**Python**

```python
from fintech_feed_latency import measurability_check, monitor, slo_report

# Ask FIRST whether your clock can resolve the threshold you care about.
check = measurability_check(clock_profile, [5.0])
if check["worst_verdict"] == "unmeasurable":
    raise SystemExit(f"need a threshold >= {check['minimum_measurable_threshold_ms']}ms")

result = monitor(events, clock_profile, warning_ms=5.0, critical_ms=15.0)
print(result["p99_ms"], result["counts"])

report = slo_report(result, objective_ms=5.0, target_share=0.99)
print(report["verdict"])   # met | breached | undecided
```

**TypeScript**

```ts
import { monitor, sloReport } from "fintech-feed-latency";

const result = monitor(events, clockProfile, 5.0, 15.0);
console.log(sloReport(result, 5.0, 0.99).verdict);
```

---

## Worked example (exact)

180 events with a declared ±0.05ms clock bound, 5ms warning and 15ms critical. These
values are asserted verbatim by both test suites from one shared JSON fixture.

```
ok                             174
warning                          2
critical                         3
clock_error_negative_latency     1
p50 2.312ms  p95 3.831ms  p99 21.848ms  max 31.901ms
sequence gaps: [{after: 10075, before: 10077}]
```

Note the shape of that distribution: a p50 of 2.3ms and a p99 of **21.8ms**. The median
is healthy and the tail is an order of magnitude worse — which is what a latency problem
actually looks like, and why a mean would have hidden it.

---

## SLO: can you measure it, and does it hold?

This is the surface that does not fit in a tutorial, and the reason to install the repo
rather than copy the snippet.

### `measurability_check` — the question nobody asks first

```
threshold    0.1ms  band 0.10ms  -> unmeasurable
threshold    1.0ms  band 0.10ms  -> clean
threshold    5.0ms  band 0.10ms  -> clean
threshold   15.0ms  band 0.10ms  -> clean
minimum cleanly measurable threshold: 1.00ms

with a +/-2.0ms clock, a 1.0ms threshold is: unmeasurable
```

**You cannot measure a 1ms threshold with a ±2ms clock bound.** Not "with difficulty" —
at all. Every observation near the threshold lands inside the uncertainty band and comes
back `threshold_uncertain`, and teams typically discover this *after* building the
dashboard, from the mysterious pile of uncertain events.

`minimum_measurable_threshold_ms` is the concrete number to take to whoever owns your
time sync.

### `slo_report` — a verdict that can say **undecided**

```
<50ms for 95%: met        worst 99.4% .. best 100.0%   (naive would say 100.0%)
<5ms  for 99%: breached   worst 96.7% .. best  97.2%   (naive would say  97.2%)
```

Compliance is computed **twice** — counting unresolved events as passes, then as
failures. If the two verdicts differ, the SLO is `undecided`, and `decidable_by` names
what would settle it.

`naive_share` is the figure the usual approach produces: compliance over the events it
could classify, silently dropping the rest. It is **always at least as good as the
truth**, which is exactly why it is reported here — so the gap is visible rather than
inferred.

An undecided SLO is a real answer. A confident wrong one is not.

### `clock_error_impact` — is it the feed, or the clock?

```
bound +/-0.001ms  uncertain 0  eligible 6/6  critical 2
bound +/-0.500ms  uncertain 4  eligible 2/6  critical 1
bound +/-3.000ms  uncertain 4  eligible 2/6  critical 1
```

At a tight bound every reading gets a verdict and two are genuinely critical. Widen it
and four of six become unclassifiable — **including one of those criticals**. The feed
did not change; the clock stopped being able to see it.

That separates two problems which look identical on a dashboard — *the feed is slow* and
*I cannot tell how slow the feed is* — and they have completely different fixes: one is a
network problem, the other is a PTP problem.

### `latency_breakdown` — where is the time going?

```
transport  p50   2.312ms  p99   21.848ms
processing p50   0.719ms  p99    1.189ms
processing is 24.9% of the p50 end-to-end
```

Half of all latency investigations end the moment someone notices the time is being
spent inside their own handler. Note the asymmetry in what these two numbers are worth:
processing latency is measured entirely on **your own** clock, so it carries no
cross-domain uncertainty at all — the smaller number, but the more trustworthy one.

---

## Row shapes

**Event** — `event_id`, `sequence`, `event_time`, `receive_time`, `process_time`
(RFC 3339 UTC, `Z` only, up to microsecond precision).

**Clock profile** — the three `*_clock_domain` fields, the three `*_timestamp_owner`
fields, `cross_domain_sync_status` (`synchronized` / `degraded` / `unknown`), and
`max_abs_offset_ms`.

**Diagnosed event** — the original fields plus `observed_transport_latency_ms`,
`processing_latency_ms`, `observed_end_to_end_latency_ms`, `transport_lower_bound_ms`,
`transport_upper_bound_ms`, `clock_quality_state`, `eligible_for_transport_summary` and
`status`.

Timestamps are validated by explicit civil arithmetic rather than `Date.parse`, which
silently rolls `2026-02-30` over to March 2. The percentile is linear-interpolated and
implemented identically in both ports so the two agree bit for bit.

---

## API reference

| Python | TypeScript | Purpose |
|---|---|---|
| `monitor(events, profile, warning_ms, critical_ms)` | `monitor(...)` | Batch diagnosis + summary |
| `diagnose_event(event, profile, warning_ms, critical_ms)` | `diagnoseEvent(...)` | One event |
| `validate_clock_profile(profile)` | `validateClockProfile(...)` | Reject an unauditable profile |
| `measurability_check(profile, thresholds_ms)` | `measurabilityCheck(...)` | Can this clock resolve these thresholds? |
| `slo_report(result, objective_ms, target_share)` | `sloReport(...)` | met / breached / **undecided** |
| `clock_error_impact(events, profile, bounds, …)` | `clockErrorImpact(...)` | Status mix across candidate bounds |
| `latency_breakdown(result)` | `latencyBreakdown(...)` | Transport vs processing |
| `percentile(values, probability)` | `percentile(...)` | Linear-interpolated percentile |
| `parse_timestamp_us(value)` | `parseTimestampUs(...)` | Strict RFC 3339 → microseconds |

---

## Edge cases & limitations

- **The clock bound is an input, not a measurement.** This package takes your attested
  `max_abs_offset_ms` at face value. Obtaining and attesting it is a PTP/NTP problem
  outside this scope — but the package makes it impossible to *skip*.
- **A negative reading is never clamped.** It is evidence about clocks. Treat a non-zero
  `clock_error_negative_latency` count as a sync incident, not a latency one.
- **Percentiles exclude untrusted readings.** A summary of `None` means the feed could
  not be measured, not that it was fast.
- **`measurability_check` bands are heuristic.** The 0.10 / 0.50 resolution ratios are
  chosen to make the question unavoidable, not as a standard. Read `resolution_ratio`.
- **Sequence gaps are reported, not recovered.** For recovery see the D01-F05 order-book
  family.
- **Microsecond precision.** Timestamps with more than six fractional digits are
  rejected rather than silently truncated.
- **One clock profile per batch.** A feed whose sync status changes mid-session needs to
  be split and monitored per regime.

---

## Testing

```bash
cd python && pytest -q          # 112 tests
cd typescript && npm test       # 117 tests
```

Both suites read the **same** `fixtures.json` and assert all 180 events' statuses, the
exact status counts, and the percentile summary to 1e-9 in each language.

The suites also pin the behaviours most likely to drift: the `threshold_uncertain` band
around 5.02ms, a wider clock bound converting a `warning` into an uncertain reading,
`processing_order_error` winning over a bad transport reading, a `synchronized` profile
with no bound being refused, and `2026-02-30` being rejected in both languages.

---

## Related algorithms

**Same family — D01-F04 Data Quality**

- **[Missing-Bar Gap Classifier](https://github.com/IslamBaraka90/Fintech-Missing-Bar-Gap-Classifier-algorithm)** — the evidence-ladder classifier for absent bars.

**Upstream — D01-F02 Cleaning and Validation**

- **[Stale Quote Detector](https://github.com/IslamBaraka90/Fintech-Stale-Quote-Detector-Data-Quality-algorithm)** — the same cross-clock discipline applied to quote age; it refuses unsound clock arithmetic outright.
- **[Crossed/Locked Market Detector](https://github.com/IslamBaraka90/Fintech-Crossed-Locked-Market-Detector-Data-Quality-algorithm)** · **[Duplicate Trade Resolver](https://github.com/IslamBaraka90/Fintech-Duplicate-Trade-Resolver-Data-Quality-algorithm)**

**Related — D01-F03 Time Synchronization** *(complete)*

- **[Previous-Tick Interpolation](https://github.com/IslamBaraka90/Fintech-Previous-Tick-Interpolation-Time-Synchronization-algorithm)** · **[Exchange-Calendar Alignment](https://github.com/IslamBaraka90/Fintech-Exchange-Calendar-Alignment-Time-Synchronization-algorithm)**

🧭 **[Browse all algorithms →](https://github.com/IslamBaraka90/Fintech-Algorithms-Awesome)**

---

## License

MIT — see [LICENSE](LICENSE).

The synthetic fixture data is CC0-1.0. Its clock bound is a declared synthetic value,
not a production clock attestation. No market data is redistributed.
