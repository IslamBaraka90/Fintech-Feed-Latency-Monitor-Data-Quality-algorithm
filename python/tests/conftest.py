"""Shared fixture access. The same JSON backs the TypeScript suite."""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "fixtures.json").read_text(encoding="utf-8")
)
CLOCK_PROFILE = FIXTURE["clock_profile"]
EVENTS = FIXTURE["events"]
WARNING_MS = FIXTURE["thresholds_ms"]["warning"]
CRITICAL_MS = FIXTURE["thresholds_ms"]["critical"]


def profile(**overrides) -> dict:
    return {**copy.deepcopy(CLOCK_PROFILE), **overrides}


def events(*indexes: int) -> list[dict]:
    if not indexes:
        return copy.deepcopy(EVENTS)
    return [copy.deepcopy(EVENTS[i]) for i in indexes]


def event(
    event_id="E1",
    sequence=1,
    event_time="2026-07-13T13:30:00.000000Z",
    receive_time="2026-07-13T13:30:00.001000Z",
    process_time="2026-07-13T13:30:00.002000Z",
):
    """A minimal 1ms-transport, 1ms-processing event."""

    return {
        "event_id": event_id,
        "sequence": sequence,
        "event_time": event_time,
        "receive_time": receive_time,
        "process_time": process_time,
    }


def run(rows=None, clock_profile=None, warning_ms=None, critical_ms=None):
    from fintech_feed_latency import monitor

    return monitor(
        events() if rows is None else rows,
        profile() if clock_profile is None else clock_profile,
        WARNING_MS if warning_ms is None else warning_ms,
        CRITICAL_MS if critical_ms is None else critical_ms,
    )
