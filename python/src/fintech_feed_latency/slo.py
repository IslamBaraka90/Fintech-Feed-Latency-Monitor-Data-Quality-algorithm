"""Can you even measure this SLO, and does the feed meet it?

The core module reports what each event's latency was and how much of that reading is
trustworthy. This module answers the two questions that follow, and the first one is
almost never asked.

**Can this threshold be measured at all?** — :func:`measurability_check`
You cannot measure a 1ms threshold with a ±2ms clock bound. Not "with difficulty" —
*at all*. Every observation near the threshold lands inside the uncertainty band, and
the monitor honestly reports ``threshold_uncertain`` for all of them. Teams discover
this after building the dashboard, from the mysterious pile of uncertain events. This
is the pre-flight that says so up front, with the minimum threshold your current clock
sync can actually resolve.

**Does the feed meet the objective?** — :func:`slo_report`
With the uncertain events handled honestly. The usual approach computes compliance over
the events it could classify and silently drops the rest, which reports a number that
is always at least as good as the truth. This instead computes compliance twice —
counting uncertain events as passes, then as failures — and if the two verdicts differ,
the SLO is **undecided**. An undecided SLO is a real answer. A confident wrong one is
not.

**How much of my uncertainty is the clock's fault?** — :func:`clock_error_impact`
Re-runs the diagnosis across candidate clock bounds and shows how the status mix moves.
It separates "the feed is slow" from "I cannot tell how slow the feed is", which have
completely different fixes — one is a network problem and the other is a PTP problem.

**Where is the time actually going?** — :func:`latency_breakdown`
Transport versus processing. Half of all latency investigations end the moment someone
notices the time is being spent inside their own handler.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from .core import (
    ELIGIBLE_STATUSES,
    STATUSES,
    diagnose_event,
    monitor,
    percentile,
    validate_clock_profile,
)

__all__ = [
    "clock_error_impact",
    "latency_breakdown",
    "measurability_check",
    "slo_report",
]

#: 2*bound of uncertainty around a threshold; at or below this share of the threshold
#: itself the measurement is considered clean.
_CLEAN_RESOLUTION_RATIO = 0.10
_MARGINAL_RESOLUTION_RATIO = 0.50


def _require_result(result: Mapping[str, Any]) -> Mapping[str, Any]:
    if (
        not isinstance(result, Mapping)
        or "events" not in result
        or "counts" not in result
        or "clock_profile" not in result
    ):
        raise ValueError("result must come from monitor()")
    return result


def measurability_check(
    clock_profile: Mapping[str, Any], thresholds_ms: Iterable[float]
) -> dict[str, Any]:
    """Ask whether the attested clock bound can resolve the thresholds you care about.

    For each threshold, the uncertainty band around it is ``2 * max_abs_offset_ms``
    wide — an observation anywhere in that band cannot be classified either side.
    ``resolution_ratio`` is that width as a share of the threshold:

    ``clean`` (≤ 0.10)
        The band is a rounding error next to the threshold. Measure away.
    ``marginal`` (≤ 0.50)
        A meaningful slice of readings near the threshold will be uncertain. Usable,
        but expect the uncertain bucket to be non-trivial and account for it.
    ``unmeasurable`` (> 0.50)
        The band is comparable to the threshold itself. Any compliance figure here is
        an artefact of the clock, not a property of the feed.

    ``minimum_measurable_threshold_ms`` is the smallest threshold that would come out
    ``clean`` on this profile — the number to take to whoever owns your time sync.

    A profile that is not ``synchronized``, or has no attested bound, is
    ``unmeasurable`` for every threshold. That is not pedantry: without a bound there
    is no interval, and without an interval there is no measurement.
    """

    profile = validate_clock_profile(clock_profile)
    candidates = [float(value) for value in thresholds_ms]
    if not candidates:
        raise ValueError("thresholds_ms must not be empty")
    if any(value <= 0 for value in candidates):
        raise ValueError("thresholds must be positive")

    bound = profile["max_abs_offset_ms"]
    trusted = profile["cross_domain_sync_status"] == "synchronized" and bound is not None

    rows: list[dict[str, Any]] = []
    for threshold in sorted(candidates):
        if not trusted:
            rows.append(
                {
                    "threshold_ms": threshold,
                    "uncertainty_band_ms": None,
                    "resolution_ratio": None,
                    "verdict": "unmeasurable",
                    "reason": "no attested clock bound to measure against",
                }
            )
            continue

        band = 2 * float(bound)
        ratio = band / threshold
        if ratio <= _CLEAN_RESOLUTION_RATIO:
            verdict, reason = "clean", "clock bound is small relative to the threshold"
        elif ratio <= _MARGINAL_RESOLUTION_RATIO:
            verdict, reason = (
                "marginal",
                "a meaningful share of readings near the threshold will be uncertain",
            )
        else:
            verdict, reason = (
                "unmeasurable",
                "clock uncertainty is comparable to the threshold itself",
            )
        rows.append(
            {
                "threshold_ms": threshold,
                "uncertainty_band_ms": band,
                "resolution_ratio": ratio,
                "verdict": verdict,
                "reason": reason,
            }
        )

    return {
        "cross_domain_sync_status": profile["cross_domain_sync_status"],
        "max_abs_offset_ms": bound,
        "thresholds": rows,
        # The smallest threshold this profile could resolve cleanly.
        "minimum_measurable_threshold_ms": (
            (2 * float(bound)) / _CLEAN_RESOLUTION_RATIO if trusted else None
        ),
        "all_measurable": all(row["verdict"] == "clean" for row in rows),
        "worst_verdict": (
            "unmeasurable"
            if any(row["verdict"] == "unmeasurable" for row in rows)
            else "marginal"
            if any(row["verdict"] == "marginal" for row in rows)
            else "clean"
        ),
    }


def slo_report(
    result: Mapping[str, Any], objective_ms: float, target_share: float = 0.99
) -> dict[str, Any]:
    """Evaluate a latency objective, counting the uncertain events both ways.

    Args:
        result: Output of :func:`~fintech_feed_latency.core.monitor`.
        objective_ms: The transport latency each event should stay under.
        target_share: The share of events required to meet it, e.g. ``0.99``.

    Returns:
        A mapping whose ``verdict`` is ``met``, ``breached`` or **``undecided``**.

        ``undecided`` is the one that earns this function its place. It means the
        answer flips depending on how the ``threshold_uncertain`` and clock-error
        events are counted — so the honest report is that the SLO was not measured,
        not that it passed. ``decidable_by`` names what would settle it.
    """

    _require_result(result)
    if (
        isinstance(objective_ms, bool)
        or not isinstance(objective_ms, (int, float))
        or objective_ms <= 0
    ):
        raise ValueError("objective_ms must be a positive number")
    if not 0 < target_share <= 1:
        raise ValueError("target_share must be in (0, 1]")

    rows = list(result["events"])
    total = len(rows)
    if total == 0:
        raise ValueError("result contains no events")

    classified_pass = 0
    classified_fail = 0
    unresolved = 0
    for row in rows:
        if row["status"] in ELIGIBLE_STATUSES:
            if float(row["observed_transport_latency_ms"]) < objective_ms:
                classified_pass += 1
            else:
                classified_fail += 1
        else:
            # Not a pass and not a fail — the reading could not be trusted at all.
            unresolved += 1

    best_share = (classified_pass + unresolved) / total
    worst_share = classified_pass / total
    best_meets = best_share >= target_share
    worst_meets = worst_share >= target_share

    if best_meets and worst_meets:
        verdict, decidable_by = "met", None
    elif not best_meets and not worst_meets:
        verdict, decidable_by = "breached", None
    else:
        verdict = "undecided"
        decidable_by = (
            "tightening the clock bound, or resolving the untrusted events, so the "
            f"{unresolved} unresolved reading(s) fall on one side"
        )

    return {
        "objective_ms": float(objective_ms),
        "target_share": float(target_share),
        "total_events": total,
        "passing": classified_pass,
        "failing": classified_fail,
        # Events whose reading could not be trusted enough to classify either way.
        "unresolved": unresolved,
        "best_case_share": best_share,
        "worst_case_share": worst_share,
        "verdict": verdict,
        "decidable_by": decidable_by,
        # The naive figure, computed over classified events only — reported so the gap
        # to worst_case_share is visible rather than inferred.
        "naive_share": (
            classified_pass / (classified_pass + classified_fail)
            if classified_pass + classified_fail
            else None
        ),
    }


def clock_error_impact(
    events: Iterable[Mapping[str, Any]],
    clock_profile: Mapping[str, Any],
    candidate_bounds_ms: Iterable[float],
    warning_ms: float = 5.0,
    critical_ms: float = 15.0,
) -> list[dict[str, Any]]:
    """Re-diagnose the batch across candidate clock bounds and report the status mix.

    This separates two problems that look identical on a dashboard: **the feed is
    slow** and **I cannot tell how slow the feed is**. Tightening the bound moves
    events out of ``threshold_uncertain`` and into a real verdict; if the ``critical``
    count barely moves while ``threshold_uncertain`` collapses, the latency was always
    there and your clocks were hiding it.

    Take the smallest bound that leaves ``threshold_uncertain`` acceptable to whoever
    owns time sync — it is a concrete, costed engineering ask rather than "our
    monitoring is flaky".
    """

    profile = validate_clock_profile(clock_profile)
    event_list = [dict(event) for event in events]
    if not event_list:
        raise ValueError("events must not be empty")
    bounds = [float(value) for value in candidate_bounds_ms]
    if not bounds:
        raise ValueError("candidate_bounds_ms must not be empty")
    if any(value < 0 for value in bounds):
        raise ValueError("candidate bounds must be non-negative")

    rows: list[dict[str, Any]] = []
    for bound in bounds:
        candidate_profile = {**profile, "max_abs_offset_ms": bound}
        diagnosed = [
            diagnose_event(event, candidate_profile, warning_ms, critical_ms)
            for event in event_list
        ]
        counts = {
            status: sum(row["status"] == status for row in diagnosed)
            for status in STATUSES
        }
        eligible = sum(1 for row in diagnosed if row["eligible_for_transport_summary"])
        rows.append(
            {
                "max_abs_offset_ms": bound,
                "counts": counts,
                "eligible": eligible,
                "eligible_share": eligible / len(diagnosed),
                "uncertain": counts["threshold_uncertain"],
            }
        )
    return rows


def latency_breakdown(result: Mapping[str, Any]) -> dict[str, Any]:
    """Split the observed latency into transport and processing.

    Both are computed over eligible events only, and reported side by side because the
    comparison is the point: transport latency is somebody else's network, processing
    latency is your own handler, and half of all latency investigations end the moment
    someone notices which one dominates.

    Note the asymmetry in what these two numbers are worth. Processing latency is
    measured entirely on **your own** clock, so it carries no cross-domain uncertainty
    at all — it is the more trustworthy of the two even though it is usually the
    smaller.
    """

    _require_result(result)
    eligible = [
        row for row in result["events"] if row["eligible_for_transport_summary"]
    ]
    if not eligible:
        return {
            "eligible_events": 0,
            "transport": None,
            "processing": None,
            "end_to_end": None,
            "processing_share_of_p50": None,
        }

    def stats(key: str) -> dict[str, float]:
        values = [float(row[key]) for row in eligible]
        return {
            "p50_ms": percentile(values, 0.50),
            "p95_ms": percentile(values, 0.95),
            "p99_ms": percentile(values, 0.99),
            "max_ms": max(values),
            "min_ms": min(values),
        }

    transport = stats("observed_transport_latency_ms")
    processing = stats("processing_latency_ms")
    end_to_end = stats("observed_end_to_end_latency_ms")

    return {
        "eligible_events": len(eligible),
        "transport": transport,
        "processing": processing,
        "end_to_end": end_to_end,
        # Above ~0.5 the bottleneck is inside your own process, not the network.
        "processing_share_of_p50": (
            processing["p50_ms"] / end_to_end["p50_ms"]
            if end_to_end["p50_ms"]
            else None
        ),
    }
