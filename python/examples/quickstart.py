"""Measure feed latency honestly, then find out whether you could measure it at all.

Run:  python examples/quickstart.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from fintech_feed_latency import (  # noqa: E402
    clock_error_impact,
    diagnose_event,
    latency_breakdown,
    measurability_check,
    monitor,
    slo_report,
)

FIXTURE = json.loads(
    (ROOT / "tests" / "fixtures" / "fixtures.json").read_text(encoding="utf-8")
)
EVENTS = FIXTURE["events"]
PROFILE = FIXTURE["clock_profile"]
WARNING_MS = FIXTURE["thresholds_ms"]["warning"]
CRITICAL_MS = FIXTURE["thresholds_ms"]["critical"]


def rule(title: str) -> None:
    print(f"\n{title}\n{'-' * len(title)}")


def at(microseconds: int) -> str:
    whole = 13 * 3_600_000_000 + 30 * 60_000_000 + microseconds
    hours, rest = divmod(whole, 3_600_000_000)
    minutes, rest = divmod(rest, 60_000_000)
    seconds, micros = divmod(rest, 1_000_000)
    return f"2026-07-13T{hours:02d}:{minutes:02d}:{seconds:02d}.{micros:06d}Z"


def spaced(transport_ms: float, processing_ms: float = 1.0) -> dict:
    return {
        "event_id": "probe", "sequence": 1,
        "event_time": at(0),
        "receive_time": at(round(transport_ms * 1000)),
        "process_time": at(round((transport_ms + processing_ms) * 1000)),
    }


# --- 1. three clocks, not one ----------------------------------------------- #
rule("1. Three timestamps, three owners")

for field in ("source", "ingress", "ready"):
    print(f"  {field + '_time':<14} owner: {PROFILE[field + '_timestamp_owner']}")
print(f"  attested clock bound: +/-{PROFILE['max_abs_offset_ms']}ms "
      f"({PROFILE['cross_domain_sync_status']})")
print("  Subtracting the venue's clock from yours measures latency PLUS that offset.")

# --- 2. the status most monitors do not have -------------------------------- #
rule("2. A reading that straddles the threshold is not a pass")

for observed in (4.5, 5.02, 6.0):
    row = diagnose_event(spaced(observed), PROFILE, WARNING_MS, CRITICAL_MS)
    interval = (f"[{row['transport_lower_bound_ms']:.2f}, "
                f"{row['transport_upper_bound_ms']:.2f}]")
    print(f"  observed {observed:>5.2f}ms  true value in {interval:<16} -> {row['status']}")
print(f"  The 5.02ms reading brackets the {WARNING_MS}ms threshold. Not a pass, not a")
print("  fail — unknowable. Rounding it to 'ok' is how an SLO reports compliance it")
print("  never measured.")

# --- 3. the batch ------------------------------------------------------------ #
rule("3. Monitoring 180 events")

result = monitor(EVENTS, PROFILE, WARNING_MS, CRITICAL_MS)
for status, count in result["counts"].items():
    if count:
        print(f"  {status:<30} {count:>3}")
print(f"  p50 {result['p50_ms']:.3f}ms  p95 {result['p95_ms']:.3f}ms  "
      f"p99 {result['p99_ms']:.3f}ms  max {result['max_ms']:.3f}ms")
print(f"  sequence gaps: {result['sequence_gaps']}")

# --- 4. could you measure this at all? -------------------------------------- #
rule("4. Measurability: can this clock resolve these thresholds?")

check = measurability_check(PROFILE, [0.1, 1.0, 5.0, 15.0])
for row in check["thresholds"]:
    band = "n/a" if row["uncertainty_band_ms"] is None else f"{row['uncertainty_band_ms']:.2f}ms"
    print(f"  threshold {row['threshold_ms']:>6.1f}ms  band {band:<8} -> {row['verdict']}")
print(f"  minimum cleanly measurable threshold: "
      f"{check['minimum_measurable_threshold_ms']:.2f}ms")

loose = measurability_check({**PROFILE, "max_abs_offset_ms": 2.0}, [1.0])
print(f"  with a +/-2.0ms clock, a 1.0ms threshold is: {loose['thresholds'][0]['verdict']}")

# --- 5. the SLO verdict ----------------------------------------------------- #
rule("5. An SLO verdict that can say 'undecided'")

for objective, target in ((50.0, 0.95), (5.0, 0.99)):
    report = slo_report(result, objective_ms=objective, target_share=target)
    print(f"  <{objective}ms for {target:.0%}: {report['verdict']:<10} "
          f"worst {report['worst_case_share']:.1%} .. best {report['best_case_share']:.1%}"
          f"  (naive would say {report['naive_share']:.1%})")

# --- 6. is it the feed or the clock? ---------------------------------------- #
rule("6. Separating 'the feed is slow' from 'I cannot tell how slow'")

probes = [
    {**spaced(value), "event_id": f"E{index}", "sequence": index}
    for index, value in enumerate([1.0, 4.9, 5.1, 14.8, 15.2, 30.0])
]
for point in clock_error_impact(probes, PROFILE, [0.001, 0.5, 3.0], WARNING_MS, CRITICAL_MS):
    print(f"  bound +/-{point['max_abs_offset_ms']:>5.3f}ms  "
          f"uncertain {point['uncertain']}  eligible {point['eligible']}/6  "
          f"critical {point['counts']['critical']}")
print("  At +/-0.001ms every reading gets a verdict and 2 are genuinely critical. Widen")
print("  the bound and 4 of 6 readings become unclassifiable — including one of those")
print("  criticals. The feed did not change; the clock stopped being able to see it.")

# --- 7. where is the time going? -------------------------------------------- #
rule("7. Transport versus processing")

breakdown = latency_breakdown(result)
print(f"  transport  p50 {breakdown['transport']['p50_ms']:>7.3f}ms  "
      f"p99 {breakdown['transport']['p99_ms']:>8.3f}ms")
print(f"  processing p50 {breakdown['processing']['p50_ms']:>7.3f}ms  "
      f"p99 {breakdown['processing']['p99_ms']:>8.3f}ms")
print(f"  processing is {breakdown['processing_share_of_p50']:.1%} of the p50 end-to-end")
print("  Processing latency is measured entirely on your own clock — the smaller")
print("  number, but the more trustworthy one.")
