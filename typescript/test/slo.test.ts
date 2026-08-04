/** Tests for measurability, SLO verdicts, clock-error impact and the latency split. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { monitor } from "../src/core.ts";
import {
  clockErrorImpact,
  latencyBreakdown,
  measurabilityCheck,
  sloReport,
} from "../src/slo.ts";
import {
  CRITICAL_MS,
  WARNING_MS,
  at,
  batch,
  event,
  events,
  profile,
  run,
  spaced,
} from "./fixtures.ts";

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol;

const UNTRUSTED = { cross_domain_sync_status: "unknown", max_abs_offset_ms: null };

// --- measurabilityCheck ---------------------------------------------------------- //
test("a tight clock measures a coarse threshold cleanly", () => {
  const check = measurabilityCheck(profile({ max_abs_offset_ms: 0.05 }), [15.0]);
  assert.equal(check.thresholds[0]!.verdict, "clean");
  assert.ok(close(check.thresholds[0]!.uncertainty_band_ms!, 0.1));
});

test("a loose clock cannot measure a fine threshold", () => {
  // You cannot measure a 1ms threshold with a +/-2ms bound. Not with difficulty — at all.
  const check = measurabilityCheck(profile({ max_abs_offset_ms: 2.0 }), [1.0]);
  assert.equal(check.thresholds[0]!.verdict, "unmeasurable");
  assert.ok(check.thresholds[0]!.resolution_ratio! > 0.5);
});

test("the marginal band is reported separately", () => {
  const check = measurabilityCheck(profile({ max_abs_offset_ms: 0.5 }), [5.0]);
  assert.equal(check.thresholds[0]!.verdict, "marginal");
  assert.ok(close(check.thresholds[0]!.resolution_ratio!, 0.2));
});

test("the minimum measurable threshold is reported", () => {
  // The number to take to whoever owns time sync.
  const check = measurabilityCheck(profile({ max_abs_offset_ms: 0.05 }), [15.0]);
  assert.ok(close(check.minimum_measurable_threshold_ms!, 1.0));
});

test("the minimum threshold is itself clean", () => {
  const minimum = measurabilityCheck(profile({ max_abs_offset_ms: 0.05 }), [15.0])
    .minimum_measurable_threshold_ms!;
  assert.equal(
    measurabilityCheck(profile({ max_abs_offset_ms: 0.05 }), [minimum]).thresholds[0]!
      .verdict,
    "clean",
  );
});

test("no attested bound is unmeasurable for everything", () => {
  // Without a bound there is no interval, and without an interval no measurement.
  const check = measurabilityCheck(profile(UNTRUSTED), [5.0, 500.0]);
  assert.deepEqual(check.thresholds.map((row) => row.verdict), [
    "unmeasurable",
    "unmeasurable",
  ]);
  assert.equal(check.minimum_measurable_threshold_ms, null);
});

test("thresholds come back sorted", () => {
  const check = measurabilityCheck(profile(), [15.0, 5.0, 100.0]);
  assert.deepEqual(check.thresholds.map((row) => row.threshold_ms), [5.0, 15.0, 100.0]);
});

test("the worst verdict summarises the set", () => {
  const check = measurabilityCheck(profile({ max_abs_offset_ms: 0.5 }), [5.0, 500.0]);
  assert.equal(check.worst_verdict, "marginal");
  assert.equal(check.all_measurable, false);
});

test("all measurable when every threshold is clean", () => {
  const check = measurabilityCheck(profile({ max_abs_offset_ms: 0.05 }), [15.0, 100.0]);
  assert.equal(check.all_measurable, true);
  assert.equal(check.worst_verdict, "clean");
});

for (const bad of [[], [0], [-1]] as number[][]) {
  test(`bad thresholds throw (${JSON.stringify(bad)})`, () => {
    assert.throws(() => measurabilityCheck(profile(), bad));
  });
}

// --- sloReport -------------------------------------------------------------------- //
test("a clean fast feed meets its objective", () => {
  const report = sloReport(batch([1.0, 1.1, 1.2, 1.3]), 5.0, 0.99);
  assert.equal(report.verdict, "met");
  assert.equal(report.unresolved, 0);
  assert.equal(report.best_case_share, 1);
  assert.equal(report.worst_case_share, 1);
});

test("a slow feed breaches", () => {
  const report = sloReport(batch([20.0, 21.0, 22.0, 23.0]), 5.0, 0.99);
  assert.equal(report.verdict, "breached");
  assert.equal(report.failing, 4);
});

test("uncertain events can leave the SLO undecided", () => {
  // The verdict flips depending on how the unresolved readings are counted.
  const report = sloReport(batch([1.0, 1.0, 1.0, 5.02]), 5.0, 0.99);
  assert.equal(report.unresolved, 1);
  assert.equal(report.verdict, "undecided");
  assert.ok(report.best_case_share > report.worst_case_share);
  assert.ok(report.decidable_by!.includes("clock bound"));
});

test("the naive share is reported so the gap is visible", () => {
  // The usual approach drops unresolved events and always looks at least as good.
  const report = sloReport(batch([1.0, 1.0, 1.0, 5.02]), 5.0, 0.99);
  assert.equal(report.naive_share, 1);
  assert.ok(close(report.worst_case_share, 0.75));
});

test("untrusted events count as unresolved not passes", () => {
  const report = sloReport(batch([1.0, 1.0], profile(UNTRUSTED)), 5.0, 0.5);
  assert.equal(report.unresolved, 2);
  assert.equal(report.worst_case_share, 0);
  assert.equal(report.best_case_share, 1);
  assert.equal(report.verdict, "undecided");
});

test("the objective boundary is exclusive", () => {
  // Meeting an objective means staying UNDER it.
  assert.equal(sloReport(batch([4.9]), 5.0, 1.0).passing, 1);
  // 5.02 lands in the uncertainty band, so use a value clear of it.
  assert.equal(sloReport(batch([6.0]), 5.0, 1.0).failing, 1);
});

test("a loose target tolerates a failure", () => {
  assert.equal(sloReport(batch([1.0, 1.0, 1.0, 20.0]), 5.0, 0.7).verdict, "met");
});

test("the fixture meets a generous objective", () => {
  const report = sloReport(run(), 50.0, 0.95);
  assert.equal(report.total_events, 180);
  assert.ok(["met", "undecided"].includes(report.verdict));
});

for (const bad of [0, -1, "5", true, null, NaN] as unknown[]) {
  test(`a bad objective throws (${String(bad)})`, () => {
    assert.throws(() => sloReport(run(), bad as number), /objective_ms/);
  });
}

for (const bad of [0, -0.1, 1.1]) {
  test(`a bad target share throws (${bad})`, () => {
    assert.throws(() => sloReport(run(), 5.0, bad), /target_share/);
  });
}

test("the report rejects foreign input", () => {
  assert.throws(() => sloReport({ nope: 1 }, 5.0), /monitor/);
});

// --- clockErrorImpact -------------------------------------------------------------- //
test("a tighter bound resolves uncertain events", () => {
  const rows = [
    spaced(5.02, 1.0, { event_id: "A", sequence: 1 }),
    spaced(1.0, 1.0, { event_id: "B", sequence: 2 }),
  ];
  const sweep = clockErrorImpact(rows, profile(), [2.0, 0.5, 0.001], WARNING_MS, CRITICAL_MS);
  assert.ok(sweep[0]!.uncertain >= sweep.at(-1)!.uncertain);
  assert.equal(sweep.at(-1)!.uncertain, 0);
});

test("a wider bound makes more events uncertain", () => {
  const rows = [1.0, 5.5, 15.5, 20.0].map((value, index) =>
    spaced(value, 1.0, { event_id: `E${index}`, sequence: index }),
  );
  const sweep = clockErrorImpact(rows, profile(), [0.001, 5.0], WARNING_MS, CRITICAL_MS);
  assert.ok(sweep[1]!.uncertain > sweep[0]!.uncertain);
  assert.ok(sweep[1]!.eligible < sweep[0]!.eligible);
});

test("the sweep separates a slow feed from a bad clock", () => {
  // Critical count barely moves while uncertainty collapses -> the latency was real.
  const rows = [30.0, 31.0, 32.0].map((value, index) =>
    spaced(value, 1.0, { event_id: `E${index}`, sequence: index }),
  );
  const sweep = clockErrorImpact(rows, profile(), [5.0, 0.001], WARNING_MS, CRITICAL_MS);
  assert.equal(sweep[0]!.counts.critical, 3);
  assert.equal(sweep[1]!.counts.critical, 3);
});

test("one point per candidate in order", () => {
  const sweep = clockErrorImpact(events(0, 1), profile(), [0.05, 1.0, 2.0], WARNING_MS, CRITICAL_MS);
  assert.deepEqual(sweep.map((row) => row.max_abs_offset_ms), [0.05, 1.0, 2.0]);
});

test("the eligible share is over the batch", () => {
  const sweep = clockErrorImpact(events(0, 1), profile(), [0.05], WARNING_MS, CRITICAL_MS);
  assert.equal(sweep[0]!.eligible_share, sweep[0]!.eligible / 2);
});

for (const bad of [[], [-1]] as number[][]) {
  test(`bad candidate bounds throw (${JSON.stringify(bad)})`, () => {
    assert.throws(() => clockErrorImpact(events(0), profile(), bad, WARNING_MS, CRITICAL_MS));
  });
}

test("an empty event list throws", () => {
  assert.throws(
    () => clockErrorImpact([], profile(), [0.05], WARNING_MS, CRITICAL_MS),
    /events must not be empty/,
  );
});

// --- latencyBreakdown ----------------------------------------------------------------- //
test("the breakdown splits transport from processing", () => {
  const breakdown = latencyBreakdown(batch([4.0, 4.0, 4.0]));
  assert.ok(close(breakdown.transport!.p50_ms, 4));
  assert.ok(close(breakdown.processing!.p50_ms, 1));
  assert.ok(close(breakdown.end_to_end!.p50_ms, 5));
});

test("the processing share names the bottleneck", () => {
  // Above ~0.5 the time is being spent inside your own handler.
  const rows = [0, 1, 2].map((index) =>
    event({
      event_id: `E${index}`,
      sequence: index,
      event_time: at(0),
      receive_time: at(1000),
      process_time: at(9000),
    }),
  );
  const breakdown = latencyBreakdown(monitor(rows, profile(), WARNING_MS, CRITICAL_MS));
  assert.ok(close(breakdown.processing_share_of_p50!, 8 / 9));
});

test("the breakdown uses eligible events only", () => {
  const result = run();
  assert.equal(
    latencyBreakdown(result).eligible_events,
    result.counts.ok! + result.counts.warning! + result.counts.critical!,
  );
});

test("the breakdown agrees with the monitor summary", () => {
  const result = run();
  const breakdown = latencyBreakdown(result);
  assert.ok(close(breakdown.transport!.p50_ms, result.p50_ms!));
  assert.ok(close(breakdown.transport!.max_ms, result.max_ms!));
});

test("no eligible events produces no breakdown", () => {
  const breakdown = latencyBreakdown(batch([1.0], profile(UNTRUSTED)));
  assert.equal(breakdown.eligible_events, 0);
  assert.equal(breakdown.transport, null);
  assert.equal(breakdown.processing_share_of_p50, null);
});

test("the breakdown rejects foreign input", () => {
  assert.throws(() => latencyBreakdown({ nope: 1 }), /monitor/);
});
