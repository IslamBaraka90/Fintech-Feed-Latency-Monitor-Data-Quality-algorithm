"""Auditable feed-latency diagnostics with explicit clock ownership.

The mistake this module exists to prevent
------------------------------------------
Latency is a subtraction, and subtraction assumes both numbers came off the same
clock. In a market-data path they almost never do:

* ``event_time`` is stamped by the **venue**.
* ``receive_time`` is stamped by **your** NIC or capture card.
* ``process_time`` is stamped by **your** feed handler.

Subtracting the venue's clock from yours does not measure transport latency. It
measures transport latency **plus the offset between two clocks you do not control
jointly**. If those clocks are 3ms apart, every "1ms" reading is somewhere between
-2ms and 4ms, and a dashboard reporting 1ms is reporting a number nobody can
substantiate.

So the clock profile is a required argument, not a configuration nicety. It names who
owns each timestamp, whether the domains are synchronized, and — the part everything
else hinges on — ``max_abs_offset_ms``, the attested bound on that offset.

The status that most monitors do not have
------------------------------------------
``threshold_uncertain``.

If your warning threshold is 5ms, your clock bound is ±2ms, and you observe 4.5ms,
then the true latency is somewhere in [2.5, 6.5] — which straddles the threshold. You
did not pass. You did not fail. **You cannot tell**, and the honest output says so.

Rounding that to "ok" is the single most common way a latency SLO reports compliance
it never measured. Every event carries ``transport_lower_bound_ms`` and
``transport_upper_bound_ms`` so the uncertainty travels with the number.

Nothing is corrected
--------------------
A negative observed transport latency is reported as
``clock_error_negative_latency``, not clamped to zero. An event arriving before it was
sent is impossible, so the reading is evidence about your **clocks**, and clamping it
destroys exactly the evidence you need. Same for ``processing_order_error``: two
timestamps from the *same* consumer clock arriving out of order is a bug in your own
pipeline, and it is reported rather than smoothed.

Only ``ok`` / ``warning`` / ``critical`` events are eligible for the transport
summary. A percentile computed over untrustworthy readings is a confident number built
from unusable evidence.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from math import isfinite
from typing import Any, Iterable, Mapping

__all__ = [
    "STATUSES",
    "TRUSTED_SYNC",
    "diagnose_event",
    "format_timestamp_us",
    "monitor",
    "parse_timestamp_us",
    "percentile",
    "validate_clock_profile",
]

TRUSTED_SYNC = "synchronized"

#: Every status this module can report, in reporting order.
STATUSES = (
    "ok",
    "warning",
    "critical",
    "threshold_uncertain",
    "clock_error_negative_latency",
    "clock_untrusted",
    "processing_order_error",
)

#: Statuses whose transport reading may enter a summary.
ELIGIBLE_STATUSES = frozenset({"ok", "warning", "critical"})

_SYNC_STATES = frozenset({"synchronized", "degraded", "unknown"})

#: RFC 3339 UTC, ``Z`` only, up to microsecond precision.
_TIMESTAMP = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$"
)

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

_REQUIRED_PROFILE_FIELDS = (
    "source_clock_domain",
    "ingress_clock_domain",
    "ready_clock_domain",
    "source_timestamp_owner",
    "ingress_timestamp_owner",
    "ready_timestamp_owner",
    "cross_domain_sync_status",
    "max_abs_offset_ms",
)


def parse_timestamp_us(value: Any, field: str = "timestamp") -> int:
    """Parse a UTC timestamp to integer microseconds. ``Z`` only, strict on dates."""

    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError(f"timestamp must be UTC ISO-8601 ending in Z: {value!r}")
    match = _TIMESTAMP.match(value)
    if match is None:
        raise ValueError(f"timestamp must be UTC ISO-8601 ending in Z: {value!r}")

    year, month, day, hour, minute, second = (int(part) for part in match.groups()[:6])
    fraction = match.group(7) or ""
    microsecond = int(fraction.ljust(6, "0")) if fraction else 0
    try:
        moment = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)
    except ValueError as exc:
        raise ValueError(f"{field} is not a real calendar time: {value!r}") from exc

    delta: timedelta = moment - _EPOCH
    return delta.days * 86_400_000_000 + delta.seconds * 1_000_000 + microsecond


def format_timestamp_us(microseconds: int) -> str:
    """Render integer microseconds back to the RFC 3339 form this package accepts."""

    moment = _EPOCH + timedelta(microseconds=microseconds)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond:06d}Z"


def _validate_thresholds(warning_ms: Any, critical_ms: Any) -> tuple[float, float]:
    for value, name in ((warning_ms, "warning_ms"), (critical_ms, "critical_ms")):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value):
            raise ValueError("thresholds must be finite")
    if warning_ms < 0 or critical_ms <= warning_ms:
        raise ValueError("require 0 <= warning_ms < critical_ms")
    return float(warning_ms), float(critical_ms)


def validate_clock_profile(profile: Mapping[str, Any]) -> dict[str, Any]:
    """Reject a profile that could not support an auditable measurement.

    The last check is the one that matters: a profile claiming ``synchronized`` with no
    ``max_abs_offset_ms`` is claiming precision it has not attested. "The clocks are in
    sync" without a bound is a belief, not a measurement, and every latency figure
    derived from it inherits that.
    """

    if not isinstance(profile, Mapping):
        raise ValueError("clock_profile must be a mapping")
    missing = [field for field in _REQUIRED_PROFILE_FIELDS if field not in profile]
    if missing:
        raise ValueError(f"clock_profile missing fields: {', '.join(missing)}")

    if profile["cross_domain_sync_status"] not in _SYNC_STATES:
        raise ValueError(
            "cross_domain_sync_status must be synchronized, degraded, or unknown"
        )

    bound = profile["max_abs_offset_ms"]
    if bound is not None and (
        isinstance(bound, bool)
        or not isinstance(bound, (int, float))
        or not isfinite(bound)
        or bound < 0
    ):
        raise ValueError("max_abs_offset_ms must be null or a finite non-negative number")
    if profile["cross_domain_sync_status"] == TRUSTED_SYNC and bound is None:
        raise ValueError("a synchronized profile needs max_abs_offset_ms")
    return dict(profile)


def percentile(values: list[float], probability: float) -> float:
    """Linear-interpolated percentile. Identical in both ports, by construction."""

    if not values:
        raise ValueError("percentile needs at least one value")
    if isinstance(probability, bool) or not isinstance(probability, (int, float)):
        raise ValueError("probability must be in [0, 1]")
    if not 0 <= probability <= 1:
        raise ValueError("probability must be in [0, 1]")

    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def diagnose_event(
    event: Mapping[str, Any],
    clock_profile: Mapping[str, Any],
    warning_ms: float = 5.0,
    critical_ms: float = 15.0,
) -> dict[str, Any]:
    """Diagnose one event without correcting or clamping an observed duration.

    The status ladder is ordered by which problem *owns* the reading, most fundamental
    first — a reversed consumer timestamp is your pipeline's bug and is reported as
    such even if the transport number also looks bad, because fixing the latency would
    not fix it.
    """

    warning_ms, critical_ms = _validate_thresholds(warning_ms, critical_ms)
    profile = validate_clock_profile(clock_profile)
    if not isinstance(event, Mapping):
        raise ValueError("each event must be a mapping")

    source_us = parse_timestamp_us(event["event_time"], "event_time")
    ingress_us = parse_timestamp_us(event["receive_time"], "receive_time")
    ready_us = parse_timestamp_us(event["process_time"], "process_time")

    observed_transport_ms = (ingress_us - source_us) / 1000
    observed_processing_ms = (ready_us - ingress_us) / 1000

    bound = profile["max_abs_offset_ms"]
    clock_trusted = (
        profile["cross_domain_sync_status"] == TRUSTED_SYNC and bound is not None
    )
    same_consumer_clock = (
        profile["ingress_clock_domain"] == profile["ready_clock_domain"]
    )

    if observed_processing_ms < 0:
        # Both stamps come off the SAME consumer clock, so this is our own bug.
        status = "processing_order_error"
        clock_quality_state = "consumer_timestamp_order_reversed"
    elif not same_consumer_clock:
        status = "clock_untrusted"
        clock_quality_state = "consumer_clock_domains_not_comparable"
    elif not clock_trusted:
        status = "clock_untrusted"
        clock_quality_state = "source_ingress_clocks_not_trusted"
    elif observed_transport_ms < 0:
        # Arriving before it was sent is impossible; this is evidence about clocks.
        status = "clock_error_negative_latency"
        clock_quality_state = "negative_observed_latency"
    elif any(
        observed_transport_ms - bound < threshold <= observed_transport_ms + bound
        for threshold in (warning_ms, critical_ms)
    ):
        # The true value straddles a threshold. Not a pass, not a fail — unknowable.
        status = "threshold_uncertain"
        clock_quality_state = "synchronized_but_threshold_within_clock_error_bound"
    elif observed_transport_ms >= critical_ms:
        status = "critical"
        clock_quality_state = "synchronized"
    elif observed_transport_ms >= warning_ms:
        status = "warning"
        clock_quality_state = "synchronized"
    else:
        status = "ok"
        clock_quality_state = "synchronized"

    return {
        **event,
        "observed_transport_latency_ms": observed_transport_ms,
        "processing_latency_ms": observed_processing_ms,
        "observed_end_to_end_latency_ms": observed_transport_ms + observed_processing_ms,
        # The interval the true latency lies in. Null when no bound was attested,
        # which is itself the answer to "how precisely can you measure this?".
        "transport_lower_bound_ms": (
            observed_transport_ms - bound if bound is not None else None
        ),
        "transport_upper_bound_ms": (
            observed_transport_ms + bound if bound is not None else None
        ),
        "clock_quality_state": clock_quality_state,
        "eligible_for_transport_summary": status in ELIGIBLE_STATUSES,
        "status": status,
    }


def monitor(
    events: Iterable[Mapping[str, Any]],
    clock_profile: Mapping[str, Any],
    warning_ms: float = 5.0,
    critical_ms: float = 15.0,
) -> dict[str, Any]:
    """Return per-event evidence, trusted summaries, and sequence diagnostics.

    Percentiles are computed over **eligible events only**. That is the honest choice
    and it has a consequence worth stating: a feed whose clocks are untrustworthy
    produces a summary of ``None`` rather than a reassuring number. See
    :func:`fintech_feed_latency.slo.slo_report` for what to do about the events the
    summary had to leave out.
    """

    warning_ms, critical_ms = _validate_thresholds(warning_ms, critical_ms)
    profile = validate_clock_profile(clock_profile)

    rows = [diagnose_event(event, profile, warning_ms, critical_ms) for event in events]
    if not rows:
        raise ValueError("events must not be empty")
    if len({row["event_id"] for row in rows}) != len(rows):
        raise ValueError("event_id must be unique")

    sequence_gaps = [
        {"after": left["sequence"], "before": right["sequence"]}
        for left, right in zip(rows, rows[1:])
        if right["sequence"] != left["sequence"] + 1
    ]

    latencies = [
        row["observed_transport_latency_ms"]
        for row in rows
        if row["eligible_for_transport_summary"]
    ]
    counts = {status: sum(row["status"] == status for row in rows) for status in STATUSES}
    summary = (
        {
            "p50_ms": percentile(latencies, 0.50),
            "p95_ms": percentile(latencies, 0.95),
            "p99_ms": percentile(latencies, 0.99),
            "max_ms": max(latencies),
        }
        if latencies
        else {"p50_ms": None, "p95_ms": None, "p99_ms": None, "max_ms": None}
    )

    return {
        "events": rows,
        "clock_profile": profile,
        "counts": counts,
        **summary,
        "sequence_gaps": sequence_gaps,
    }
