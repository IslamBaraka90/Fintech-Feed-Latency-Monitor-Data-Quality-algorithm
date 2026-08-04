"""Tests for measurability, SLO verdicts, clock-error impact and the latency split."""

from __future__ import annotations

import pytest
from conftest import CRITICAL_MS, WARNING_MS, event, events, profile, run

from fintech_feed_latency import (
    clock_error_impact,
    latency_breakdown,
    measurability_check,
    monitor,
    slo_report,
)


def at(microseconds: int) -> str:
    whole = 13 * 3_600_000_000 + 30 * 60_000_000 + microseconds
    hours, rest = divmod(whole, 3_600_000_000)
    minutes, rest = divmod(rest, 60_000_000)
    seconds, micros = divmod(rest, 1_000_000)
    return f"2026-07-13T{hours:02d}:{minutes:02d}:{seconds:02d}.{micros:06d}Z"


def spaced(transport_ms, processing_ms=1.0, **overrides):
    return event(
        event_time=at(0),
        receive_time=at(round(transport_ms * 1000)),
        process_time=at(round((transport_ms + processing_ms) * 1000)),
        **overrides,
    )


def batch(*transports, clock_profile=None):
    rows = [
        spaced(value, event_id=f"E{index}", sequence=index)
        for index, value in enumerate(transports)
    ]
    return monitor(rows, clock_profile or profile(), WARNING_MS, CRITICAL_MS)


# --- measurability_check ---------------------------------------------------------- #
def test_a_tight_clock_measures_a_coarse_threshold_cleanly():
    check = measurability_check(profile(max_abs_offset_ms=0.05), [15.0])
    assert check["thresholds"][0]["verdict"] == "clean"
    assert check["thresholds"][0]["uncertainty_band_ms"] == pytest.approx(0.1)


def test_a_loose_clock_cannot_measure_a_fine_threshold():
    """You cannot measure a 1ms threshold with a +/-2ms bound. Not with difficulty — at all."""

    check = measurability_check(profile(max_abs_offset_ms=2.0), [1.0])
    assert check["thresholds"][0]["verdict"] == "unmeasurable"
    assert check["thresholds"][0]["resolution_ratio"] > 0.5


def test_the_marginal_band_is_reported_separately():
    check = measurability_check(profile(max_abs_offset_ms=0.5), [5.0])
    assert check["thresholds"][0]["verdict"] == "marginal"
    assert check["thresholds"][0]["resolution_ratio"] == pytest.approx(0.2)


def test_the_minimum_measurable_threshold_is_reported():
    """The number to take to whoever owns time sync."""

    check = measurability_check(profile(max_abs_offset_ms=0.05), [15.0])
    assert check["minimum_measurable_threshold_ms"] == pytest.approx(1.0)


def test_the_minimum_threshold_is_itself_clean():
    check = measurability_check(profile(max_abs_offset_ms=0.05), [15.0])
    minimum = check["minimum_measurable_threshold_ms"]
    assert measurability_check(profile(max_abs_offset_ms=0.05), [minimum])[
        "thresholds"
    ][0]["verdict"] == "clean"


def test_no_attested_bound_is_unmeasurable_for_everything():
    """Without a bound there is no interval, and without an interval no measurement."""

    check = measurability_check(
        profile(cross_domain_sync_status="unknown", max_abs_offset_ms=None), [5.0, 500.0]
    )
    assert [row["verdict"] for row in check["thresholds"]] == ["unmeasurable"] * 2
    assert check["minimum_measurable_threshold_ms"] is None


def test_thresholds_come_back_sorted():
    check = measurability_check(profile(), [15.0, 5.0, 100.0])
    assert [row["threshold_ms"] for row in check["thresholds"]] == [5.0, 15.0, 100.0]


def test_the_worst_verdict_summarises_the_set():
    check = measurability_check(profile(max_abs_offset_ms=0.5), [5.0, 500.0])
    assert check["worst_verdict"] == "marginal"
    assert check["all_measurable"] is False


def test_all_measurable_when_every_threshold_is_clean():
    check = measurability_check(profile(max_abs_offset_ms=0.05), [15.0, 100.0])
    assert check["all_measurable"] is True
    assert check["worst_verdict"] == "clean"


@pytest.mark.parametrize("bad", [[], [0], [-1]])
def test_bad_thresholds_raise(bad):
    with pytest.raises(ValueError):
        measurability_check(profile(), bad)


# --- slo_report -------------------------------------------------------------------- #
def test_a_clean_fast_feed_meets_its_objective():
    report = slo_report(batch(1.0, 1.1, 1.2, 1.3), objective_ms=5.0, target_share=0.99)
    assert report["verdict"] == "met"
    assert report["unresolved"] == 0
    assert report["best_case_share"] == report["worst_case_share"] == 1.0


def test_a_slow_feed_breaches():
    report = slo_report(batch(20.0, 21.0, 22.0, 23.0), objective_ms=5.0, target_share=0.99)
    assert report["verdict"] == "breached"
    assert report["failing"] == 4


def test_uncertain_events_can_leave_the_slo_undecided():
    """The verdict flips depending on how the unresolved readings are counted."""

    result = batch(1.0, 1.0, 1.0, 5.02)
    report = slo_report(result, objective_ms=5.0, target_share=0.99)
    assert report["unresolved"] == 1
    assert report["verdict"] == "undecided"
    assert report["best_case_share"] > report["worst_case_share"]
    assert "clock bound" in report["decidable_by"]


def test_the_naive_share_is_reported_so_the_gap_is_visible():
    """The usual approach drops unresolved events and always looks at least as good."""

    report = slo_report(batch(1.0, 1.0, 1.0, 5.02), objective_ms=5.0, target_share=0.99)
    assert report["naive_share"] == 1.0
    assert report["worst_case_share"] == pytest.approx(0.75)


def test_untrusted_events_count_as_unresolved_not_passes():
    result = batch(1.0, 1.0, clock_profile=profile(cross_domain_sync_status="unknown",
                                                   max_abs_offset_ms=None))
    report = slo_report(result, objective_ms=5.0, target_share=0.5)
    assert report["unresolved"] == 2
    assert report["worst_case_share"] == 0.0
    assert report["best_case_share"] == 1.0
    assert report["verdict"] == "undecided"


def test_the_objective_boundary_is_exclusive():
    """Meeting an objective means staying UNDER it."""

    assert slo_report(batch(4.9), objective_ms=5.0, target_share=1.0)["passing"] == 1
    # 5.02 lands in the uncertainty band, so use a value clear of it.
    assert slo_report(batch(6.0), objective_ms=5.0, target_share=1.0)["failing"] == 1


def test_a_loose_target_tolerates_a_failure():
    report = slo_report(batch(1.0, 1.0, 1.0, 20.0), objective_ms=5.0, target_share=0.70)
    assert report["verdict"] == "met"


def test_the_fixture_meets_a_generous_objective():
    report = slo_report(run(), objective_ms=50.0, target_share=0.95)
    assert report["total_events"] == 180
    assert report["verdict"] in {"met", "undecided"}


@pytest.mark.parametrize("bad", [0, -1, "5", True, None])
def test_a_bad_objective_raises(bad):
    with pytest.raises(ValueError, match="objective_ms"):
        slo_report(run(), objective_ms=bad)


@pytest.mark.parametrize("bad", [0, -0.1, 1.1])
def test_a_bad_target_share_raises(bad):
    with pytest.raises(ValueError, match="target_share"):
        slo_report(run(), objective_ms=5.0, target_share=bad)


def test_the_report_rejects_foreign_input():
    with pytest.raises(ValueError, match="monitor"):
        slo_report({"nope": 1}, objective_ms=5.0)


# --- clock_error_impact -------------------------------------------------------------- #
def test_a_tighter_bound_resolves_uncertain_events():
    rows = [spaced(5.02, event_id="A", sequence=1), spaced(1.0, event_id="B", sequence=2)]
    sweep = clock_error_impact(rows, profile(), [2.0, 0.5, 0.001], WARNING_MS, CRITICAL_MS)
    assert sweep[0]["uncertain"] >= sweep[-1]["uncertain"]
    assert sweep[-1]["uncertain"] == 0


def test_a_wider_bound_makes_more_events_uncertain():
    rows = [
        spaced(value, event_id=f"E{index}", sequence=index)
        for index, value in enumerate([1.0, 5.5, 15.5, 20.0])
    ]
    sweep = clock_error_impact(rows, profile(), [0.001, 5.0], WARNING_MS, CRITICAL_MS)
    assert sweep[1]["uncertain"] > sweep[0]["uncertain"]
    assert sweep[1]["eligible"] < sweep[0]["eligible"]


def test_the_sweep_separates_a_slow_feed_from_a_bad_clock():
    """Critical count barely moves while uncertainty collapses -> the latency was real."""

    rows = [
        spaced(value, event_id=f"E{index}", sequence=index)
        for index, value in enumerate([30.0, 31.0, 32.0])
    ]
    sweep = clock_error_impact(rows, profile(), [5.0, 0.001], WARNING_MS, CRITICAL_MS)
    assert sweep[0]["counts"]["critical"] == sweep[1]["counts"]["critical"] == 3


def test_one_point_per_candidate_in_order():
    sweep = clock_error_impact(events(0, 1), profile(), [0.05, 1.0, 2.0], WARNING_MS, CRITICAL_MS)
    assert [row["max_abs_offset_ms"] for row in sweep] == [0.05, 1.0, 2.0]


def test_the_eligible_share_is_over_the_batch():
    sweep = clock_error_impact(events(0, 1), profile(), [0.05], WARNING_MS, CRITICAL_MS)
    assert sweep[0]["eligible_share"] == sweep[0]["eligible"] / 2


@pytest.mark.parametrize("bad", [[], [-1]])
def test_bad_candidate_bounds_raise(bad):
    with pytest.raises(ValueError):
        clock_error_impact(events(0), profile(), bad, WARNING_MS, CRITICAL_MS)


def test_an_empty_event_list_raises():
    with pytest.raises(ValueError, match="events must not be empty"):
        clock_error_impact([], profile(), [0.05], WARNING_MS, CRITICAL_MS)


# --- latency_breakdown ----------------------------------------------------------------- #
def test_the_breakdown_splits_transport_from_processing():
    breakdown = latency_breakdown(batch(4.0, 4.0, 4.0))
    assert breakdown["transport"]["p50_ms"] == pytest.approx(4.0)
    assert breakdown["processing"]["p50_ms"] == pytest.approx(1.0)
    assert breakdown["end_to_end"]["p50_ms"] == pytest.approx(5.0)


def test_the_processing_share_names_the_bottleneck():
    """Above ~0.5 the time is being spent inside your own handler."""

    rows = [
        event(
            event_id=f"E{index}",
            sequence=index,
            event_time=at(0),
            receive_time=at(1000),
            process_time=at(9000),
        )
        for index in range(3)
    ]
    breakdown = latency_breakdown(monitor(rows, profile(), WARNING_MS, CRITICAL_MS))
    assert breakdown["processing_share_of_p50"] == pytest.approx(8 / 9)


def test_the_breakdown_uses_eligible_events_only():
    result = run()
    breakdown = latency_breakdown(result)
    assert breakdown["eligible_events"] == sum(
        result["counts"][status] for status in ("ok", "warning", "critical")
    )


def test_the_breakdown_agrees_with_the_monitor_summary():
    result = run()
    assert latency_breakdown(result)["transport"]["p50_ms"] == pytest.approx(result["p50_ms"])
    assert latency_breakdown(result)["transport"]["max_ms"] == pytest.approx(result["max_ms"])


def test_no_eligible_events_produces_no_breakdown():
    result = batch(1.0, clock_profile=profile(cross_domain_sync_status="unknown",
                                              max_abs_offset_ms=None))
    breakdown = latency_breakdown(result)
    assert breakdown["eligible_events"] == 0
    assert breakdown["transport"] is None
    assert breakdown["processing_share_of_p50"] is None


def test_the_breakdown_rejects_foreign_input():
    with pytest.raises(ValueError, match="monitor"):
        latency_breakdown({"nope": 1})
