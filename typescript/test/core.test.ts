/**
 * Contract tests for the latency monitor.
 *
 * The fixture is the cross-language acceptance anchor: 180 events with a declared
 * ±0.05ms clock bound, each carrying an `expected_status`. Those statuses, the status
 * counts, and the percentile summary are asserted verbatim by this suite and by the
 * Python one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  STATUSES,
  diagnoseEvent,
  monitor,
  parseTimestampUs,
  percentile,
  validateClockProfile,
} from "../src/core.ts";
import {
  CRITICAL_MS,
  EVENTS,
  WARNING_MS,
  at,
  event,
  events,
  profile,
  run,
  spaced,
} from "./fixtures.ts";

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol;

// --- the shared fixture ------------------------------------------------------- //
test("every event matches its expected status", () => {
  const rows = run().events;
  EVENTS.forEach((original, index) => {
    assert.equal(rows[index]!.status, original.expected_status, original.event_id);
  });
});

test("the fixture counts are exact", () => {
  assert.deepEqual(run().counts, {
    ok: 174,
    warning: 2,
    critical: 3,
    threshold_uncertain: 0,
    clock_error_negative_latency: 1,
    clock_untrusted: 0,
    processing_order_error: 0,
  });
});

test("the percentile summary is exact", () => {
  const result = run();
  assert.ok(close(result.p50_ms!, 2.312));
  assert.ok(close(result.p95_ms!, 3.8308999999999997));
  assert.ok(close(result.p99_ms!, 21.84783999999999));
  assert.ok(close(result.max_ms!, 31.901));
});

test("the sequence gap is found", () => {
  assert.deepEqual(run().sequence_gaps, [{ after: 10075, before: 10077 }]);
});

test("one row per event in order", () => {
  const result = run();
  assert.equal(result.events.length, 180);
  assert.deepEqual(
    result.events.map((row) => row.event_id),
    EVENTS.map((row) => row.event_id),
  );
});

test("every declared status is counted", () => {
  assert.deepEqual(Object.keys(run().counts).sort(), [...STATUSES].sort());
});

// --- the status ladder ------------------------------------------------------------ //
test("a fast event is ok", () => {
  assert.equal(diagnoseEvent(spaced(1.0), profile(), WARNING_MS, CRITICAL_MS).status, "ok");
});

test("the warning boundary is inclusive", () => {
  assert.equal(
    diagnoseEvent(spaced(6.0), profile(), WARNING_MS, CRITICAL_MS).status,
    "warning",
  );
});

test("the critical boundary is inclusive", () => {
  assert.equal(
    diagnoseEvent(spaced(16.0), profile(), WARNING_MS, CRITICAL_MS).status,
    "critical",
  );
});

test("a reading straddling a threshold is uncertain", () => {
  // 5ms threshold, +/-0.05ms bound, observed 5.02ms -> [4.97, 5.07].
  const row = diagnoseEvent(spaced(5.02), profile(), WARNING_MS, CRITICAL_MS);
  assert.equal(row.status, "threshold_uncertain");
  assert.equal(
    row.clock_quality_state,
    "synchronized_but_threshold_within_clock_error_bound",
  );
  assert.equal(row.eligible_for_transport_summary, false);
});

test("an uncertain reading is not rounded to a pass", () => {
  const row = diagnoseEvent(spaced(5.02), profile(), WARNING_MS, CRITICAL_MS);
  assert.ok(!["ok", "warning", "critical"].includes(row.status));
});

test("a wider bound makes more readings uncertain", () => {
  const tight = diagnoseEvent(
    spaced(5.5), profile({ max_abs_offset_ms: 0.05 }), WARNING_MS, CRITICAL_MS);
  const loose = diagnoseEvent(
    spaced(5.5), profile({ max_abs_offset_ms: 2.0 }), WARNING_MS, CRITICAL_MS);
  assert.equal(tight.status, "warning");
  assert.equal(loose.status, "threshold_uncertain");
});

test("a negative transport reading is reported not clamped", () => {
  // Arriving before it was sent is evidence about clocks, not a zero.
  const row = diagnoseEvent(
    event({ event_time: at(5000), receive_time: at(0), process_time: at(1000) }),
    profile(),
    WARNING_MS,
    CRITICAL_MS,
  );
  assert.equal(row.status, "clock_error_negative_latency");
  assert.equal(row.observed_transport_latency_ms, -5);
});

test("reversed consumer timestamps are our own bug", () => {
  const row = diagnoseEvent(
    event({ event_time: at(0), receive_time: at(2000), process_time: at(1000) }),
    profile(),
    WARNING_MS,
    CRITICAL_MS,
  );
  assert.equal(row.status, "processing_order_error");
  assert.equal(row.clock_quality_state, "consumer_timestamp_order_reversed");
});

test("processing order wins over a bad transport reading", () => {
  // Fixing the latency would not fix a reversed timestamp, so it is reported first.
  const row = diagnoseEvent(
    event({ event_time: at(9000), receive_time: at(2000), process_time: at(1000) }),
    profile(),
    WARNING_MS,
    CRITICAL_MS,
  );
  assert.equal(row.status, "processing_order_error");
});

for (const sync of ["degraded", "unknown"]) {
  test(`an untrusted profile blocks every verdict (${sync})`, () => {
    const row = diagnoseEvent(
      spaced(1.0),
      profile({ cross_domain_sync_status: sync }),
      WARNING_MS,
      CRITICAL_MS,
    );
    assert.equal(row.status, "clock_untrusted");
    assert.equal(row.clock_quality_state, "source_ingress_clocks_not_trusted");
  });
}

test("mismatched consumer domains are not comparable", () => {
  const row = diagnoseEvent(
    spaced(1.0), profile({ ready_clock_domain: "OTHER-HOST" }), WARNING_MS, CRITICAL_MS);
  assert.equal(row.status, "clock_untrusted");
  assert.equal(row.clock_quality_state, "consumer_clock_domains_not_comparable");
});

// --- the uncertainty interval travels ---------------------------------------------- //
test("every reading carries its interval", () => {
  const row = diagnoseEvent(
    spaced(2.0), profile({ max_abs_offset_ms: 0.5 }), WARNING_MS, CRITICAL_MS);
  assert.ok(close(row.transport_lower_bound_ms!, 1.5));
  assert.ok(close(row.transport_upper_bound_ms!, 2.5));
});

test("no attested bound means no interval", () => {
  const row = diagnoseEvent(
    spaced(2.0),
    profile({ cross_domain_sync_status: "unknown", max_abs_offset_ms: null }),
    WARNING_MS,
    CRITICAL_MS,
  );
  assert.equal(row.transport_lower_bound_ms, null);
  assert.equal(row.transport_upper_bound_ms, null);
});

test("end to end is the sum of the parts", () => {
  const row = diagnoseEvent(spaced(3.0, 2.0), profile(), WARNING_MS, CRITICAL_MS);
  assert.ok(close(row.observed_transport_latency_ms, 3));
  assert.ok(close(row.processing_latency_ms, 2));
  assert.ok(close(row.observed_end_to_end_latency_ms, 5));
});

test("the original event fields survive", () => {
  const row = diagnoseEvent(spaced(1.0), profile(), WARNING_MS, CRITICAL_MS);
  assert.equal(row.event_id, "E1");
  assert.equal(row.sequence, 1);
});

// --- summaries use trusted readings only -------------------------------------------- //
test("untrusted events never enter the summary", () => {
  const rows = [
    spaced(1.0, 1.0, { event_id: "A", sequence: 1 }),
    spaced(2.0, 1.0, { event_id: "B", sequence: 2 }),
  ];
  const result = monitor(
    rows,
    profile({ cross_domain_sync_status: "unknown", max_abs_offset_ms: null }),
    WARNING_MS,
    CRITICAL_MS,
  );
  assert.equal(result.p50_ms, null);
  assert.equal(result.max_ms, null);
  assert.equal(result.counts.clock_untrusted, 2);
});

test("a summary of null is better than a confident wrong number", () => {
  const result = monitor(
    [spaced(1.0, 1.0, { event_id: "A", sequence: 1 })],
    profile({ cross_domain_sync_status: "degraded" }),
    WARNING_MS,
    CRITICAL_MS,
  );
  for (const key of ["p50_ms", "p95_ms", "p99_ms", "max_ms"] as const) {
    assert.equal(result[key], null);
  }
});

test("eligibility matches the status", () => {
  for (const row of run().events) {
    assert.equal(
      row.eligible_for_transport_summary,
      ["ok", "warning", "critical"].includes(row.status),
    );
  }
});

// --- percentile --------------------------------------------------------------------- //
for (const probability of [0, 0.5, 0.99, 1]) {
  test(`a single value is every percentile (${probability})`, () => {
    assert.equal(percentile([4.0], probability), 4.0);
  });
}

test("percentiles interpolate linearly", () => {
  assert.equal(percentile([0, 10], 0), 0);
  assert.equal(percentile([0, 10], 0.5), 5);
  assert.equal(percentile([0, 10], 1), 10);
});

test("percentile is order independent", () => {
  assert.equal(percentile([3, 1, 2], 0.5), percentile([1, 2, 3], 0.5));
});

test("an empty percentile throws", () => {
  assert.throws(() => percentile([], 0.5), /at least one value/);
});

for (const bad of [-0.1, 1.1, "0.5", true, null, NaN] as unknown[]) {
  test(`a bad probability throws (${String(bad)})`, () => {
    assert.throws(() => percentile([1, 2], bad as number), /probability/);
  });
}

// --- clock profile validation --------------------------------------------------------- //
test("the fixture profile is valid", () => {
  validateClockProfile(profile());
});

for (const field of ["source_clock_domain", "ingress_clock_domain", "ready_clock_domain",
                     "source_timestamp_owner", "ingress_timestamp_owner",
                     "ready_timestamp_owner", "cross_domain_sync_status",
                     "max_abs_offset_ms"]) {
  test(`a missing ${field} throws`, () => {
    const broken = profile() as unknown as Record<string, unknown>;
    delete broken[field];
    assert.throws(() => validateClockProfile(broken), /missing fields/);
  });
}

test("an unknown sync status throws", () => {
  assert.throws(
    () => validateClockProfile(profile({ cross_domain_sync_status: "probably_fine" })),
    /synchronized, degraded, or unknown/,
  );
});

test("synchronized without a bound is refused", () => {
  // "The clocks are in sync" with no bound is a belief, not a measurement.
  assert.throws(
    () => validateClockProfile(profile({ max_abs_offset_ms: null })),
    /needs max_abs_offset_ms/,
  );
});

for (const bad of [-1, "0.05", true, NaN, Infinity] as unknown[]) {
  test(`a bad bound throws (${String(bad)})`, () => {
    assert.throws(
      () => validateClockProfile(profile({ max_abs_offset_ms: bad })),
      /max_abs_offset_ms/,
    );
  });
}

test("an unsynchronized profile may omit the bound", () => {
  validateClockProfile(
    profile({ cross_domain_sync_status: "unknown", max_abs_offset_ms: null }),
  );
});

// --- threshold and batch validation ---------------------------------------------------- //
for (const [warning, critical] of [
  [-1, 15], [5, 5], [15, 5], [NaN, 15], [5, Infinity],
] as Array<[number, number]>) {
  test(`bad thresholds throw (${warning}/${critical})`, () => {
    assert.throws(() => monitor(events(0), profile(), warning, critical));
  });
}

test("an empty batch throws", () => {
  assert.throws(() => monitor([], profile(), WARNING_MS, CRITICAL_MS), /must not be empty/);
});

test("a duplicate event id throws", () => {
  const rows = [
    spaced(1.0, 1.0, { event_id: "A", sequence: 1 }),
    spaced(2.0, 1.0, { event_id: "A", sequence: 2 }),
  ];
  assert.throws(
    () => monitor(rows, profile(), WARNING_MS, CRITICAL_MS),
    /event_id must be unique/,
  );
});

test("contiguous sequences produce no gaps", () => {
  const rows = [1, 2, 3].map((index) =>
    spaced(1.0, 1.0, { event_id: `E${index}`, sequence: index }),
  );
  assert.deepEqual(monitor(rows, profile(), WARNING_MS, CRITICAL_MS).sequence_gaps, []);
});

test("input rows are never mutated", () => {
  const rows = events();
  const before = JSON.stringify(rows);
  monitor(rows, profile(), WARNING_MS, CRITICAL_MS);
  assert.equal(JSON.stringify(rows), before);
});

// --- timestamps -------------------------------------------------------------------------- //
test("an impossible calendar date is rejected", () => {
  assert.throws(() => parseTimestampUs("2026-02-30T00:00:00Z"), /not a real calendar time/);
});

for (const timestamp of [
  "2026-07-13T13:30:00+00:00",
  "2026-07-13T13:30:00",
  "2026-07-13T13:30:00.1234567Z",
  "2026-13-13T13:30:00Z",
  "",
  null,
  1767623400000,
] as unknown[]) {
  test(`a malformed timestamp is rejected (${JSON.stringify(timestamp)})`, () => {
    assert.throws(() => parseTimestampUs(timestamp));
  });
}

test("microsecond precision survives", () => {
  assert.equal(
    parseTimestampUs("2026-07-13T13:30:00.000900Z") -
      parseTimestampUs("2026-07-13T13:30:00Z"),
    900,
  );
});
