/**
 * Measure feed latency honestly, then find out whether you could measure it at all.
 *
 * Run:  npm run example
 */

import { createRequire } from "node:module";

import {
  type ClockProfile,
  type LatencyEvent,
  clockErrorImpact,
  diagnoseEvent,
  latencyBreakdown,
  measurabilityCheck,
  monitor,
  sloReport,
} from "../src/index.ts";

const require = createRequire(import.meta.url);
const FIXTURE = require("../test/fixtures/fixtures.json") as {
  thresholds_ms: { warning: number; critical: number };
  clock_profile: ClockProfile;
  events: LatencyEvent[];
};

const { events: EVENTS, clock_profile: PROFILE } = FIXTURE;
const WARNING_MS = FIXTURE.thresholds_ms.warning;
const CRITICAL_MS = FIXTURE.thresholds_ms.critical;

const rule = (title: string) => console.log(`\n${title}\n${"-".repeat(title.length)}`);
const pct = (value: number, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const pad = (value: unknown, width: number) => String(value).padStart(width);

const at = (microseconds: number): string => {
  const whole = 13 * 3_600_000_000 + 30 * 60_000_000 + microseconds;
  const hours = Math.floor(whole / 3_600_000_000);
  let rest = whole % 3_600_000_000;
  const minutes = Math.floor(rest / 60_000_000);
  rest %= 60_000_000;
  const seconds = Math.floor(rest / 1_000_000);
  const micros = rest % 1_000_000;
  const p = (value: number, width = 2) => String(value).padStart(width, "0");
  return `2026-07-13T${p(hours)}:${p(minutes)}:${p(seconds)}.${p(micros, 6)}Z`;
};

const spaced = (transportMs: number, processingMs = 1.0): LatencyEvent => ({
  event_id: "probe",
  sequence: 1,
  event_time: at(0),
  receive_time: at(Math.round(transportMs * 1000)),
  process_time: at(Math.round((transportMs + processingMs) * 1000)),
});

// --- 1. three clocks, not one ----------------------------------------------- //
rule("1. Three timestamps, three owners");

for (const field of ["source", "ingress", "ready"] as const) {
  console.log(
    `  ${`${field}_time`.padEnd(14)} owner: ${PROFILE[`${field}_timestamp_owner`]}`,
  );
}
console.log(
  `  attested clock bound: +/-${PROFILE.max_abs_offset_ms}ms ` +
    `(${PROFILE.cross_domain_sync_status})`,
);
console.log("  Subtracting the venue's clock from yours measures latency PLUS that offset.");

// --- 2. the status most monitors do not have -------------------------------- //
rule("2. A reading that straddles the threshold is not a pass");

for (const observed of [4.5, 5.02, 6.0]) {
  const row = diagnoseEvent(spaced(observed), PROFILE, WARNING_MS, CRITICAL_MS);
  const interval = `[${row.transport_lower_bound_ms!.toFixed(2)}, ${row.transport_upper_bound_ms!.toFixed(2)}]`;
  console.log(
    `  observed ${pad(observed.toFixed(2), 5)}ms  true value in ${interval.padEnd(16)} -> ${row.status}`,
  );
}
console.log(`  The 5.02ms reading brackets the ${WARNING_MS}ms threshold. Not a pass, not a`);
console.log("  fail - unknowable. Rounding it to 'ok' is how an SLO reports compliance it");
console.log("  never measured.");

// --- 3. the batch ------------------------------------------------------------ //
rule("3. Monitoring 180 events");

const result = monitor(EVENTS, PROFILE, WARNING_MS, CRITICAL_MS);
for (const [status, count] of Object.entries(result.counts)) {
  if (count) console.log(`  ${status.padEnd(30)}${pad(count, 3)}`);
}
console.log(
  `  p50 ${result.p50_ms!.toFixed(3)}ms  p95 ${result.p95_ms!.toFixed(3)}ms  ` +
    `p99 ${result.p99_ms!.toFixed(3)}ms  max ${result.max_ms!.toFixed(3)}ms`,
);
console.log(`  sequence gaps: ${JSON.stringify(result.sequence_gaps)}`);

// --- 4. could you measure this at all? -------------------------------------- //
rule("4. Measurability: can this clock resolve these thresholds?");

const check = measurabilityCheck(PROFILE, [0.1, 1.0, 5.0, 15.0]);
for (const row of check.thresholds) {
  const band =
    row.uncertainty_band_ms === null ? "n/a" : `${row.uncertainty_band_ms.toFixed(2)}ms`;
  console.log(
    `  threshold ${pad(row.threshold_ms.toFixed(1), 6)}ms  band ${band.padEnd(8)} -> ${row.verdict}`,
  );
}
console.log(
  `  minimum cleanly measurable threshold: ${check.minimum_measurable_threshold_ms!.toFixed(2)}ms`,
);
const loose = measurabilityCheck({ ...PROFILE, max_abs_offset_ms: 2.0 }, [1.0]);
console.log(`  with a +/-2.0ms clock, a 1.0ms threshold is: ${loose.thresholds[0]!.verdict}`);

// --- 5. the SLO verdict ----------------------------------------------------- //
rule("5. An SLO verdict that can say 'undecided'");

for (const [objective, target] of [[50.0, 0.95], [5.0, 0.99]] as Array<[number, number]>) {
  const report = sloReport(result, objective, target);
  console.log(
    `  <${objective}ms for ${pct(target, 0)}: ${report.verdict.padEnd(10)} ` +
      `worst ${pct(report.worst_case_share)} .. best ${pct(report.best_case_share)}` +
      `  (naive would say ${pct(report.naive_share!)})`,
  );
}

// --- 6. is it the feed or the clock? ---------------------------------------- //
rule("6. Separating 'the feed is slow' from 'I cannot tell how slow'");

const probes = [1.0, 4.9, 5.1, 14.8, 15.2, 30.0].map((value, index) => ({
  ...spaced(value),
  event_id: `E${index}`,
  sequence: index,
}));
for (const point of clockErrorImpact(probes, PROFILE, [0.001, 0.5, 3.0], WARNING_MS, CRITICAL_MS)) {
  console.log(
    `  bound +/-${pad(point.max_abs_offset_ms.toFixed(3), 5)}ms  ` +
      `uncertain ${point.uncertain}  eligible ${point.eligible}/6  ` +
      `critical ${point.counts.critical}`,
  );
}
console.log("  At +/-0.001ms every reading gets a verdict and 2 are genuinely critical. Widen");
console.log("  the bound and 4 of 6 readings become unclassifiable - including one of those");
console.log("  criticals. The feed did not change; the clock stopped being able to see it.");

// --- 7. where is the time going? -------------------------------------------- //
rule("7. Transport versus processing");

const breakdown = latencyBreakdown(result);
console.log(
  `  transport  p50 ${pad(breakdown.transport!.p50_ms.toFixed(3), 7)}ms  ` +
    `p99 ${pad(breakdown.transport!.p99_ms.toFixed(3), 8)}ms`,
);
console.log(
  `  processing p50 ${pad(breakdown.processing!.p50_ms.toFixed(3), 7)}ms  ` +
    `p99 ${pad(breakdown.processing!.p99_ms.toFixed(3), 8)}ms`,
);
console.log(
  `  processing is ${pct(breakdown.processing_share_of_p50!)} of the p50 end-to-end`,
);
console.log("  Processing latency is measured entirely on your own clock - the smaller");
console.log("  number, but the more trustworthy one.");
