"""Contract tests for the latency monitor.

The fixture is the cross-language acceptance anchor: 180 events with a declared
±0.05ms clock bound, each carrying an ``expected_status``. Those statuses, the status
counts, and the percentile summary are asserted verbatim by this suite and by the
TypeScript one.
"""

from __future__ import annotations

import pytest
from conftest import (
    CRITICAL_MS,
    EVENTS,
    WARNING_MS,
    event,
    events,
    profile,
    run,
)

from fintech_feed_latency import (
    STATUSES,
    diagnose_event,
    monitor,
    parse_timestamp_us,
    percentile,
    validate_clock_profile,
)


def at(microseconds: int) -> str:
    """A timestamp offset from a fixed base by whole microseconds."""

    whole = 13 * 3_600_000_000 + 30 * 60_000_000 + microseconds
    hours = whole // 3_600_000_000
    rest = whole % 3_600_000_000
    minutes = rest // 60_000_000
    rest %= 60_000_000
    seconds = rest // 1_000_000
    micros = rest % 1_000_000
    return f"2026-07-13T{hours:02d}:{minutes:02d}:{seconds:02d}.{micros:06d}Z"


def spaced(transport_ms: float, processing_ms: float = 1.0, **overrides):
    return event(
        event_time=at(0),
        receive_time=at(round(transport_ms * 1000)),
        process_time=at(round((transport_ms + processing_ms) * 1000)),
        **overrides,
    )


# --- the shared fixture ------------------------------------------------------- #
def test_every_event_matches_its_expected_status():
    for row, original in zip(run()["events"], EVENTS):
        assert row["status"] == original["expected_status"], original["event_id"]


def test_the_fixture_counts_are_exact():
    assert run()["counts"] == {
        "ok": 174,
        "warning": 2,
        "critical": 3,
        "threshold_uncertain": 0,
        "clock_error_negative_latency": 1,
        "clock_untrusted": 0,
        "processing_order_error": 0,
    }


def test_the_percentile_summary_is_exact():
    result = run()
    assert result["p50_ms"] == pytest.approx(2.312, abs=1e-9)
    assert result["p95_ms"] == pytest.approx(3.8308999999999997, abs=1e-9)
    assert result["p99_ms"] == pytest.approx(21.84783999999999, abs=1e-9)
    assert result["max_ms"] == pytest.approx(31.901, abs=1e-9)


def test_the_sequence_gap_is_found():
    assert run()["sequence_gaps"] == [{"after": 10075, "before": 10077}]


def test_one_row_per_event_in_order():
    result = run()
    assert len(result["events"]) == 180
    assert [row["event_id"] for row in result["events"]] == [
        row["event_id"] for row in EVENTS
    ]


def test_every_declared_status_is_counted():
    assert set(run()["counts"]) == set(STATUSES)


# --- the status ladder ------------------------------------------------------------ #
def test_a_fast_event_is_ok():
    assert diagnose_event(spaced(1.0), profile(), WARNING_MS, CRITICAL_MS)["status"] == "ok"


def test_the_warning_boundary_is_inclusive():
    assert diagnose_event(spaced(6.0), profile(), WARNING_MS, CRITICAL_MS)["status"] == "warning"


def test_the_critical_boundary_is_inclusive():
    assert diagnose_event(spaced(16.0), profile(), WARNING_MS, CRITICAL_MS)["status"] == "critical"


def test_a_reading_straddling_a_threshold_is_uncertain():
    """5ms threshold, +/-0.05ms bound, observed 5.02ms -> [4.97, 5.07]."""

    row = diagnose_event(spaced(5.02), profile(), WARNING_MS, CRITICAL_MS)
    assert row["status"] == "threshold_uncertain"
    assert row["clock_quality_state"] == (
        "synchronized_but_threshold_within_clock_error_bound"
    )
    assert row["eligible_for_transport_summary"] is False


def test_an_uncertain_reading_is_not_rounded_to_a_pass():
    """The single most common way an SLO reports compliance it never measured."""

    row = diagnose_event(spaced(5.02), profile(), WARNING_MS, CRITICAL_MS)
    assert row["status"] not in {"ok", "warning", "critical"}


def test_a_wider_bound_makes_more_readings_uncertain():
    tight = diagnose_event(spaced(5.5), profile(max_abs_offset_ms=0.05), WARNING_MS, CRITICAL_MS)
    loose = diagnose_event(spaced(5.5), profile(max_abs_offset_ms=2.0), WARNING_MS, CRITICAL_MS)
    assert tight["status"] == "warning"
    assert loose["status"] == "threshold_uncertain"


def test_a_negative_transport_reading_is_reported_not_clamped():
    """Arriving before it was sent is evidence about clocks, not a zero."""

    row = diagnose_event(
        event(
            event_time=at(5000),
            receive_time=at(0),
            process_time=at(1000),
        ),
        profile(),
        WARNING_MS,
        CRITICAL_MS,
    )
    assert row["status"] == "clock_error_negative_latency"
    assert row["observed_transport_latency_ms"] == -5.0


def test_reversed_consumer_timestamps_are_our_own_bug():
    """Both stamps come off the same consumer clock, so this is not a clock offset."""

    row = diagnose_event(
        event(
            event_time=at(0),
            receive_time=at(2000),
            process_time=at(1000),
        ),
        profile(),
        WARNING_MS,
        CRITICAL_MS,
    )
    assert row["status"] == "processing_order_error"
    assert row["clock_quality_state"] == "consumer_timestamp_order_reversed"


def test_processing_order_wins_over_a_bad_transport_reading():
    """Fixing the latency would not fix a reversed timestamp, so it is reported first."""

    row = diagnose_event(
        event(
            event_time=at(9000),
            receive_time=at(2000),
            process_time=at(1000),
        ),
        profile(),
        WARNING_MS,
        CRITICAL_MS,
    )
    assert row["status"] == "processing_order_error"


@pytest.mark.parametrize("sync", ["degraded", "unknown"])
def test_an_untrusted_profile_blocks_every_verdict(sync):
    row = diagnose_event(
        spaced(1.0), profile(cross_domain_sync_status=sync), WARNING_MS, CRITICAL_MS
    )
    assert row["status"] == "clock_untrusted"
    assert row["clock_quality_state"] == "source_ingress_clocks_not_trusted"


def test_mismatched_consumer_domains_are_not_comparable():
    row = diagnose_event(
        spaced(1.0), profile(ready_clock_domain="OTHER-HOST"), WARNING_MS, CRITICAL_MS
    )
    assert row["status"] == "clock_untrusted"
    assert row["clock_quality_state"] == "consumer_clock_domains_not_comparable"


# --- the uncertainty interval travels ---------------------------------------------- #
def test_every_reading_carries_its_interval():
    row = diagnose_event(spaced(2.0), profile(max_abs_offset_ms=0.5), WARNING_MS, CRITICAL_MS)
    assert row["transport_lower_bound_ms"] == pytest.approx(1.5)
    assert row["transport_upper_bound_ms"] == pytest.approx(2.5)


def test_no_attested_bound_means_no_interval():
    """Itself the answer to 'how precisely can you measure this?'."""

    row = diagnose_event(
        spaced(2.0),
        profile(cross_domain_sync_status="unknown", max_abs_offset_ms=None),
        WARNING_MS,
        CRITICAL_MS,
    )
    assert row["transport_lower_bound_ms"] is None
    assert row["transport_upper_bound_ms"] is None


def test_end_to_end_is_the_sum_of_the_parts():
    row = diagnose_event(spaced(3.0, 2.0), profile(), WARNING_MS, CRITICAL_MS)
    assert row["observed_transport_latency_ms"] == pytest.approx(3.0)
    assert row["processing_latency_ms"] == pytest.approx(2.0)
    assert row["observed_end_to_end_latency_ms"] == pytest.approx(5.0)


def test_the_original_event_fields_survive():
    row = diagnose_event(spaced(1.0), profile(), WARNING_MS, CRITICAL_MS)
    assert row["event_id"] == "E1"
    assert row["sequence"] == 1


# --- summaries use trusted readings only -------------------------------------------- #
def test_untrusted_events_never_enter_the_summary():
    rows = [spaced(1.0, event_id="A", sequence=1), spaced(2.0, event_id="B", sequence=2)]
    result = monitor(rows, profile(cross_domain_sync_status="unknown", max_abs_offset_ms=None),
                     WARNING_MS, CRITICAL_MS)
    assert result["p50_ms"] is None
    assert result["max_ms"] is None
    assert result["counts"]["clock_untrusted"] == 2


def test_a_summary_of_none_is_better_than_a_confident_wrong_number():
    result = monitor(
        [spaced(1.0, event_id="A", sequence=1)],
        profile(cross_domain_sync_status="degraded"),
        WARNING_MS,
        CRITICAL_MS,
    )
    assert all(result[key] is None for key in ("p50_ms", "p95_ms", "p99_ms", "max_ms"))


def test_eligibility_matches_the_status():
    for row in run()["events"]:
        assert row["eligible_for_transport_summary"] == (
            row["status"] in {"ok", "warning", "critical"}
        )


# --- percentile --------------------------------------------------------------------- #
def test_a_single_value_is_every_percentile():
    for probability in (0.0, 0.5, 0.99, 1.0):
        assert percentile([4.0], probability) == 4.0


def test_percentiles_interpolate_linearly():
    values = [0.0, 10.0]
    assert percentile(values, 0.0) == 0.0
    assert percentile(values, 0.5) == 5.0
    assert percentile(values, 1.0) == 10.0


def test_percentile_is_order_independent():
    assert percentile([3.0, 1.0, 2.0], 0.5) == percentile([1.0, 2.0, 3.0], 0.5)


def test_an_empty_percentile_raises():
    with pytest.raises(ValueError, match="at least one value"):
        percentile([], 0.5)


@pytest.mark.parametrize("bad", [-0.1, 1.1, "0.5", True, None])
def test_a_bad_probability_raises(bad):
    with pytest.raises(ValueError, match="probability"):
        percentile([1.0, 2.0], bad)


# --- clock profile validation --------------------------------------------------------- #
def test_the_fixture_profile_is_valid():
    validate_clock_profile(profile())


@pytest.mark.parametrize(
    "field",
    ["source_clock_domain", "ingress_clock_domain", "ready_clock_domain",
     "source_timestamp_owner", "ingress_timestamp_owner", "ready_timestamp_owner",
     "cross_domain_sync_status", "max_abs_offset_ms"],
)
def test_a_missing_profile_field_raises(field):
    broken = profile()
    del broken[field]
    with pytest.raises(ValueError, match="missing fields"):
        validate_clock_profile(broken)


def test_an_unknown_sync_status_raises():
    with pytest.raises(ValueError, match="synchronized, degraded, or unknown"):
        validate_clock_profile(profile(cross_domain_sync_status="probably_fine"))


def test_synchronized_without_a_bound_is_refused():
    """'The clocks are in sync' with no bound is a belief, not a measurement."""

    with pytest.raises(ValueError, match="needs max_abs_offset_ms"):
        validate_clock_profile(profile(max_abs_offset_ms=None))


@pytest.mark.parametrize("bad", [-1, "0.05", True, float("nan"), float("inf")])
def test_a_bad_bound_raises(bad):
    with pytest.raises(ValueError, match="max_abs_offset_ms"):
        validate_clock_profile(profile(max_abs_offset_ms=bad))


def test_an_unsynchronized_profile_may_omit_the_bound():
    validate_clock_profile(
        profile(cross_domain_sync_status="unknown", max_abs_offset_ms=None)
    )


# --- threshold and batch validation ---------------------------------------------------- #
@pytest.mark.parametrize(
    "warning,critical",
    [(-1, 15), (5, 5), (15, 5), (float("nan"), 15), (5, float("inf"))],
)
def test_bad_thresholds_raise(warning, critical):
    with pytest.raises(ValueError):
        monitor(events(0), profile(), warning, critical)


def test_an_empty_batch_raises():
    with pytest.raises(ValueError, match="must not be empty"):
        monitor([], profile(), WARNING_MS, CRITICAL_MS)


def test_a_duplicate_event_id_raises():
    rows = [spaced(1.0, event_id="A", sequence=1), spaced(2.0, event_id="A", sequence=2)]
    with pytest.raises(ValueError, match="event_id must be unique"):
        monitor(rows, profile(), WARNING_MS, CRITICAL_MS)


def test_contiguous_sequences_produce_no_gaps():
    rows = [spaced(1.0, event_id=f"E{i}", sequence=i) for i in range(1, 4)]
    assert monitor(rows, profile(), WARNING_MS, CRITICAL_MS)["sequence_gaps"] == []


def test_input_rows_are_never_mutated():
    rows = events()
    before = [dict(row) for row in rows]
    monitor(rows, profile(), WARNING_MS, CRITICAL_MS)
    assert rows == before


# --- timestamps -------------------------------------------------------------------------- #
def test_an_impossible_calendar_date_is_rejected():
    with pytest.raises(ValueError, match="not a real calendar time"):
        parse_timestamp_us("2026-02-30T00:00:00Z")


@pytest.mark.parametrize(
    "timestamp",
    ["2026-07-13T13:30:00+00:00", "2026-07-13T13:30:00", "2026-07-13T13:30:00.1234567Z",
     "2026-13-13T13:30:00Z", "", None, 1767623400000],
)
def test_a_malformed_timestamp_is_rejected(timestamp):
    with pytest.raises(ValueError):
        parse_timestamp_us(timestamp)


def test_microsecond_precision_survives():
    assert parse_timestamp_us("2026-07-13T13:30:00.000900Z") - parse_timestamp_us(
        "2026-07-13T13:30:00Z"
    ) == 900
