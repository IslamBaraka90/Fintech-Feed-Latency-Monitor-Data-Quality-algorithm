/**
 * Auditable feed-latency diagnostics with explicit clock ownership.
 *
 * ## The mistake this module exists to prevent
 *
 * Latency is a subtraction, and subtraction assumes both numbers came off the same
 * clock. In a market-data path they almost never do:
 *
 * - `event_time` is stamped by the **venue**.
 * - `receive_time` is stamped by **your** NIC or capture card.
 * - `process_time` is stamped by **your** feed handler.
 *
 * Subtracting the venue's clock from yours does not measure transport latency. It
 * measures transport latency **plus the offset between two clocks you do not control
 * jointly**. If those clocks are 3ms apart, every "1ms" reading is somewhere between
 * -2ms and 4ms, and a dashboard reporting 1ms is reporting a number nobody can
 * substantiate.
 *
 * So the clock profile is a required argument, not a configuration nicety.
 *
 * ## The status that most monitors do not have
 *
 * `threshold_uncertain`. If your warning threshold is 5ms, your clock bound is ±2ms,
 * and you observe 4.5ms, the true latency is somewhere in [2.5, 6.5] — which straddles
 * the threshold. You did not pass. You did not fail. **You cannot tell.**
 *
 * Rounding that to "ok" is the single most common way a latency SLO reports compliance
 * it never measured.
 *
 * ## Nothing is corrected
 *
 * A negative observed transport latency is reported as `clock_error_negative_latency`,
 * not clamped to zero — an event arriving before it was sent is impossible, so the
 * reading is evidence about your **clocks**, and clamping destroys exactly the evidence
 * you need. Only `ok` / `warning` / `critical` events are eligible for the summary.
 */

export const TRUSTED_SYNC = "synchronized";

export type Status =
  | "ok"
  | "warning"
  | "critical"
  | "threshold_uncertain"
  | "clock_error_negative_latency"
  | "clock_untrusted"
  | "processing_order_error";

/** Every status this module can report, in reporting order. */
export const STATUSES: readonly Status[] = [
  "ok",
  "warning",
  "critical",
  "threshold_uncertain",
  "clock_error_negative_latency",
  "clock_untrusted",
  "processing_order_error",
];

/** Statuses whose transport reading may enter a summary. */
export const ELIGIBLE_STATUSES: ReadonlySet<string> = new Set([
  "ok",
  "warning",
  "critical",
]);

export interface ClockProfile {
  source_clock_domain: string;
  ingress_clock_domain: string;
  ready_clock_domain: string;
  source_timestamp_owner: string;
  ingress_timestamp_owner: string;
  ready_timestamp_owner: string;
  cross_domain_sync_status: "synchronized" | "degraded" | "unknown";
  max_abs_offset_ms: number | null;
  [key: string]: unknown;
}

export interface LatencyEvent {
  event_id: string;
  sequence: number;
  event_time: string;
  receive_time: string;
  process_time: string;
  [key: string]: unknown;
}

export interface DiagnosedEvent extends Record<string, unknown> {
  observed_transport_latency_ms: number;
  processing_latency_ms: number;
  observed_end_to_end_latency_ms: number;
  transport_lower_bound_ms: number | null;
  transport_upper_bound_ms: number | null;
  clock_quality_state: string;
  eligible_for_transport_summary: boolean;
  status: Status;
}

export interface MonitorResult {
  events: DiagnosedEvent[];
  clock_profile: ClockProfile;
  counts: Record<string, number>;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
  sequence_gaps: Array<{ after: number; before: number }>;
}

const SYNC_STATES = new Set(["synchronized", "degraded", "unknown"]);

/** RFC 3339 UTC, `Z` only, up to microsecond precision. */
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

const REQUIRED_PROFILE_FIELDS = [
  "source_clock_domain",
  "ingress_clock_domain",
  "ready_clock_domain",
  "source_timestamp_owner",
  "ingress_timestamp_owner",
  "ready_timestamp_owner",
  "cross_domain_sync_status",
  "max_abs_offset_ms",
] as const;

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const daysInMonth = (year: number, month: number): number =>
  month === 2 && isLeapYear(year) ? 29 : MONTH_LENGTHS[month - 1]!;

/** Days since 1970-01-01 by integer arithmetic — not `Date.UTC`, which rolls over. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** Parse a UTC timestamp to integer microseconds. `Z` only, strict on calendar dates. */
export function parseTimestampUs(value: unknown, field = "timestamp"): number {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    throw new Error(`timestamp must be UTC ISO-8601 ending in Z: ${JSON.stringify(value)}`);
  }
  const match = TIMESTAMP.exec(value);
  if (match === null) {
    throw new Error(`timestamp must be UTC ISO-8601 ending in Z: ${JSON.stringify(value)}`);
  }

  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const fraction = match[7] ?? "";
  const microsecond = fraction === "" ? 0 : Number(fraction.padEnd(6, "0"));

  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59
  ) {
    throw new Error(`${field} is not a real calendar time: ${JSON.stringify(value)}`);
  }

  return (
    daysFromCivil(year, month, day) * 86_400_000_000 +
    (hour * 3600 + minute * 60 + second) * 1_000_000 +
    microsecond
  );
}

/** Render integer microseconds back to the RFC 3339 form this package accepts. */
export function formatTimestampUs(microseconds: number): string {
  const wholeMs = Math.floor(microseconds / 1000);
  const remainder = microseconds - wholeMs * 1000;
  const iso = new Date(wholeMs).toISOString();
  return `${iso.slice(0, -1)}${String(remainder).padStart(3, "0")}Z`;
}

function validateThresholds(warningMs: unknown, criticalMs: unknown): [number, number] {
  for (const value of [warningMs, criticalMs]) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("thresholds must be finite");
    }
  }
  const warning = warningMs as number;
  const critical = criticalMs as number;
  if (warning < 0 || critical <= warning) {
    throw new Error("require 0 <= warning_ms < critical_ms");
  }
  return [warning, critical];
}

/**
 * Reject a profile that could not support an auditable measurement.
 *
 * The last check is the one that matters: a profile claiming `synchronized` with no
 * `max_abs_offset_ms` is claiming precision it has not attested. "The clocks are in
 * sync" without a bound is a belief, not a measurement.
 */
export function validateClockProfile(profile: unknown): ClockProfile {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("clock_profile must be a mapping");
  }
  const source = profile as Record<string, unknown>;
  const missing = REQUIRED_PROFILE_FIELDS.filter((field) => !(field in source));
  if (missing.length) {
    throw new Error(`clock_profile missing fields: ${missing.join(", ")}`);
  }
  if (!SYNC_STATES.has(source.cross_domain_sync_status as string)) {
    throw new Error("cross_domain_sync_status must be synchronized, degraded, or unknown");
  }

  const bound = source.max_abs_offset_ms;
  if (
    bound !== null &&
    (typeof bound !== "number" || !Number.isFinite(bound) || bound < 0)
  ) {
    throw new Error("max_abs_offset_ms must be null or a finite non-negative number");
  }
  if (source.cross_domain_sync_status === TRUSTED_SYNC && bound === null) {
    throw new Error("a synchronized profile needs max_abs_offset_ms");
  }
  return { ...source } as ClockProfile;
}

/** Linear-interpolated percentile. Identical in both ports, by construction. */
export function percentile(values: number[], probability: number): number {
  if (values.length === 0) throw new Error("percentile needs at least one value");
  if (typeof probability !== "number" || !Number.isFinite(probability)) {
    throw new Error("probability must be in [0, 1]");
  }
  if (probability < 0 || probability > 1) {
    throw new Error("probability must be in [0, 1]");
  }

  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * probability;
  const lower = Math.trunc(position);
  const upper = Math.min(lower + 1, ordered.length - 1);
  const weight = position - lower;
  return ordered[lower]! * (1 - weight) + ordered[upper]! * weight;
}

/**
 * Diagnose one event without correcting or clamping an observed duration.
 *
 * The status ladder is ordered by which problem *owns* the reading, most fundamental
 * first — a reversed consumer timestamp is your pipeline's bug and is reported as such
 * even if the transport number also looks bad, because fixing the latency would not
 * fix it.
 */
export function diagnoseEvent(
  event: unknown,
  clockProfile: unknown,
  warningMs = 5.0,
  criticalMs = 15.0,
): DiagnosedEvent {
  const [warning, critical] = validateThresholds(warningMs, criticalMs);
  const profile = validateClockProfile(clockProfile);
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("each event must be a mapping");
  }
  const source = event as Record<string, unknown>;

  const sourceUs = parseTimestampUs(source.event_time, "event_time");
  const ingressUs = parseTimestampUs(source.receive_time, "receive_time");
  const readyUs = parseTimestampUs(source.process_time, "process_time");

  const observedTransportMs = (ingressUs - sourceUs) / 1000;
  const observedProcessingMs = (readyUs - ingressUs) / 1000;

  const bound = profile.max_abs_offset_ms;
  const clockTrusted =
    profile.cross_domain_sync_status === TRUSTED_SYNC && bound !== null;
  const sameConsumerClock = profile.ingress_clock_domain === profile.ready_clock_domain;

  let status: Status;
  let clockQualityState: string;

  if (observedProcessingMs < 0) {
    // Both stamps come off the SAME consumer clock, so this is our own bug.
    status = "processing_order_error";
    clockQualityState = "consumer_timestamp_order_reversed";
  } else if (!sameConsumerClock) {
    status = "clock_untrusted";
    clockQualityState = "consumer_clock_domains_not_comparable";
  } else if (!clockTrusted) {
    status = "clock_untrusted";
    clockQualityState = "source_ingress_clocks_not_trusted";
  } else if (observedTransportMs < 0) {
    // Arriving before it was sent is impossible; this is evidence about clocks.
    status = "clock_error_negative_latency";
    clockQualityState = "negative_observed_latency";
  } else if (
    [warning, critical].some(
      (threshold) =>
        observedTransportMs - bound! < threshold &&
        threshold <= observedTransportMs + bound!,
    )
  ) {
    // The true value straddles a threshold. Not a pass, not a fail — unknowable.
    status = "threshold_uncertain";
    clockQualityState = "synchronized_but_threshold_within_clock_error_bound";
  } else if (observedTransportMs >= critical) {
    status = "critical";
    clockQualityState = "synchronized";
  } else if (observedTransportMs >= warning) {
    status = "warning";
    clockQualityState = "synchronized";
  } else {
    status = "ok";
    clockQualityState = "synchronized";
  }

  return {
    ...source,
    observed_transport_latency_ms: observedTransportMs,
    processing_latency_ms: observedProcessingMs,
    observed_end_to_end_latency_ms: observedTransportMs + observedProcessingMs,
    // The interval the true latency lies in. Null when no bound was attested, which is
    // itself the answer to "how precisely can you measure this?".
    transport_lower_bound_ms: bound === null ? null : observedTransportMs - bound,
    transport_upper_bound_ms: bound === null ? null : observedTransportMs + bound,
    clock_quality_state: clockQualityState,
    eligible_for_transport_summary: ELIGIBLE_STATUSES.has(status),
    status,
  };
}

/**
 * Return per-event evidence, trusted summaries, and sequence diagnostics.
 *
 * Percentiles are computed over **eligible events only**. That is the honest choice and
 * it has a consequence worth stating: a feed whose clocks are untrustworthy produces a
 * summary of `null` rather than a reassuring number.
 */
export function monitor(
  events: Iterable<unknown>,
  clockProfile: unknown,
  warningMs = 5.0,
  criticalMs = 15.0,
): MonitorResult {
  const [warning, critical] = validateThresholds(warningMs, criticalMs);
  const profile = validateClockProfile(clockProfile);

  const rows = [...events].map((event) =>
    diagnoseEvent(event, profile, warning, critical),
  );
  if (rows.length === 0) throw new Error("events must not be empty");
  if (new Set(rows.map((row) => row.event_id)).size !== rows.length) {
    throw new Error("event_id must be unique");
  }

  const sequenceGaps: Array<{ after: number; before: number }> = [];
  for (let index = 1; index < rows.length; index += 1) {
    const before = rows[index - 1]!.sequence as number;
    const after = rows[index]!.sequence as number;
    if (after !== before + 1) sequenceGaps.push({ after: before, before: after });
  }

  const latencies = rows
    .filter((row) => row.eligible_for_transport_summary)
    .map((row) => row.observed_transport_latency_ms);

  const counts: Record<string, number> = {};
  for (const status of STATUSES) {
    counts[status] = rows.filter((row) => row.status === status).length;
  }

  return {
    events: rows,
    clock_profile: profile,
    counts,
    p50_ms: latencies.length ? percentile(latencies, 0.5) : null,
    p95_ms: latencies.length ? percentile(latencies, 0.95) : null,
    p99_ms: latencies.length ? percentile(latencies, 0.99) : null,
    max_ms: latencies.length ? Math.max(...latencies) : null,
    sequence_gaps: sequenceGaps,
  };
}
