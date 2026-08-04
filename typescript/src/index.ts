/**
 * Auditable feed-latency diagnostics with explicit clock ownership.
 *
 * Latency is a subtraction, and subtraction assumes both timestamps came off the same
 * clock. In a market-data path they do not: the venue stamps one, your NIC stamps
 * another, your handler stamps a third. This package makes the clock profile a required
 * argument, carries the uncertainty bound with every reading, and reports
 * `threshold_uncertain` when the true value straddles a threshold instead of rounding
 * it to a pass.
 *
 * ```ts
 * import { monitor } from "fintech-feed-latency";
 *
 * const result = monitor(events, clockProfile, 5.0, 15.0);
 * ```
 *
 * Article: https://thefintechbuilder.com/market-data-engineering/data-quality/feed-latency-monitor/
 */

export {
  type ClockProfile,
  type DiagnosedEvent,
  type LatencyEvent,
  type MonitorResult,
  type Status,
  ELIGIBLE_STATUSES,
  STATUSES,
  TRUSTED_SYNC,
  diagnoseEvent,
  formatTimestampUs,
  monitor,
  parseTimestampUs,
  percentile,
  validateClockProfile,
} from "./core.ts";

export {
  type ImpactPoint,
  type LatencyBreakdown,
  type LatencyStats,
  type MeasurabilityCheck,
  type SloReport,
  type ThresholdRow,
  type Verdict,
  clockErrorImpact,
  latencyBreakdown,
  measurabilityCheck,
  sloReport,
} from "./slo.ts";
