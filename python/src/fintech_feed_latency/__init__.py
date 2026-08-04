"""Auditable feed-latency diagnostics with explicit clock ownership.

Latency is a subtraction, and subtraction assumes both timestamps came off the same
clock. In a market-data path they do not: the venue stamps one, your NIC stamps
another, your handler stamps a third. This package makes the clock profile a required
argument, carries the uncertainty bound with every reading, and reports
``threshold_uncertain`` when the true value straddles a threshold instead of rounding
it to a pass.

Quickstart::

    from fintech_feed_latency import monitor

    result = monitor(events, clock_profile, warning_ms=5.0, critical_ms=15.0)

See :mod:`fintech_feed_latency.core` for the diagnosis and
:mod:`fintech_feed_latency.slo` for measurability, SLO verdicts and clock-error impact.

Article: https://thefintechbuilder.com/market-data-engineering/data-quality/feed-latency-monitor/
"""

from .core import (
    ELIGIBLE_STATUSES,
    STATUSES,
    TRUSTED_SYNC,
    diagnose_event,
    format_timestamp_us,
    monitor,
    parse_timestamp_us,
    percentile,
    validate_clock_profile,
)
from .slo import (
    clock_error_impact,
    latency_breakdown,
    measurability_check,
    slo_report,
)

__version__ = "0.1.0"

__all__ = [
    "ELIGIBLE_STATUSES",
    "STATUSES",
    "TRUSTED_SYNC",
    "__version__",
    "clock_error_impact",
    "diagnose_event",
    "format_timestamp_us",
    "latency_breakdown",
    "measurability_check",
    "monitor",
    "parse_timestamp_us",
    "percentile",
    "slo_report",
    "validate_clock_profile",
]
