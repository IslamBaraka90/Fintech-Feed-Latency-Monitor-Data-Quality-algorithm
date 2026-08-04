/**
 * Can you even measure this SLO, and does the feed meet it?
 *
 * **Can this threshold be measured at all?** — {@link measurabilityCheck}
 * You cannot measure a 1ms threshold with a ±2ms clock bound. Not "with difficulty" —
 * *at all*. Every observation near the threshold lands inside the uncertainty band, and
 * the monitor honestly reports `threshold_uncertain` for all of them. Teams discover
 * this after building the dashboard, from the mysterious pile of uncertain events.
 *
 * **Does the feed meet the objective?** — {@link sloReport}
 * The usual approach computes compliance over the events it could classify and silently
 * drops the rest, which reports a number always at least as good as the truth. This
 * computes compliance twice — uncertain events as passes, then as failures — and if the
 * verdicts differ, the SLO is **undecided**. An undecided SLO is a real answer.
 *
 * **How much of my uncertainty is the clock's fault?** — {@link clockErrorImpact}
 * Separates "the feed is slow" from "I cannot tell how slow the feed is" — a network
 * problem and a PTP problem, with completely different fixes.
 *
 * **Where is the time going?** — {@link latencyBreakdown}
 * Transport versus processing.
 */

import {
  ELIGIBLE_STATUSES,
  STATUSES,
  type ClockProfile,
  type MonitorResult,
  diagnoseEvent,
  percentile,
  validateClockProfile,
} from "./core.ts";

const CLEAN_RESOLUTION_RATIO = 0.1;
const MARGINAL_RESOLUTION_RATIO = 0.5;

export type Verdict = "clean" | "marginal" | "unmeasurable";

export interface ThresholdRow {
  threshold_ms: number;
  uncertainty_band_ms: number | null;
  resolution_ratio: number | null;
  verdict: Verdict;
  reason: string;
}

export interface MeasurabilityCheck {
  cross_domain_sync_status: string;
  max_abs_offset_ms: number | null;
  thresholds: ThresholdRow[];
  minimum_measurable_threshold_ms: number | null;
  all_measurable: boolean;
  worst_verdict: Verdict;
}

export interface SloReport {
  objective_ms: number;
  target_share: number;
  total_events: number;
  passing: number;
  failing: number;
  unresolved: number;
  best_case_share: number;
  worst_case_share: number;
  verdict: "met" | "breached" | "undecided";
  decidable_by: string | null;
  naive_share: number | null;
}

export interface ImpactPoint {
  max_abs_offset_ms: number;
  counts: Record<string, number>;
  eligible: number;
  eligible_share: number;
  uncertain: number;
}

export interface LatencyStats {
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  min_ms: number;
}

export interface LatencyBreakdown {
  eligible_events: number;
  transport: LatencyStats | null;
  processing: LatencyStats | null;
  end_to_end: LatencyStats | null;
  processing_share_of_p50: number | null;
}

function requireResult(result: unknown): MonitorResult {
  if (
    result === null || typeof result !== "object" ||
    !("events" in result) || !("counts" in result) || !("clock_profile" in result)
  ) {
    throw new Error("result must come from monitor()");
  }
  return result as MonitorResult;
}

/**
 * Ask whether the attested clock bound can resolve the thresholds you care about.
 *
 * For each threshold the uncertainty band is `2 * max_abs_offset_ms` wide — an
 * observation anywhere in it cannot be classified either side. `resolution_ratio` is
 * that width as a share of the threshold: `clean` (≤0.10), `marginal` (≤0.50),
 * `unmeasurable` (>0.50, where any compliance figure is an artefact of the clock).
 *
 * `minimum_measurable_threshold_ms` is the smallest threshold that would come out
 * clean on this profile — the number to take to whoever owns your time sync.
 */
export function measurabilityCheck(
  clockProfile: unknown,
  thresholdsMs: Iterable<number>,
): MeasurabilityCheck {
  const profile: ClockProfile = validateClockProfile(clockProfile);
  const candidates = [...thresholdsMs].map(Number);
  if (candidates.length === 0) throw new Error("thresholds_ms must not be empty");
  if (candidates.some((value) => !(value > 0))) {
    throw new Error("thresholds must be positive");
  }

  const bound = profile.max_abs_offset_ms;
  const trusted = profile.cross_domain_sync_status === "synchronized" && bound !== null;

  const rows: ThresholdRow[] = [];
  for (const threshold of [...candidates].sort((a, b) => a - b)) {
    if (!trusted) {
      rows.push({
        threshold_ms: threshold,
        uncertainty_band_ms: null,
        resolution_ratio: null,
        verdict: "unmeasurable",
        reason: "no attested clock bound to measure against",
      });
      continue;
    }
    const band = 2 * bound!;
    const ratio = band / threshold;
    let verdict: Verdict;
    let reason: string;
    if (ratio <= CLEAN_RESOLUTION_RATIO) {
      verdict = "clean";
      reason = "clock bound is small relative to the threshold";
    } else if (ratio <= MARGINAL_RESOLUTION_RATIO) {
      verdict = "marginal";
      reason = "a meaningful share of readings near the threshold will be uncertain";
    } else {
      verdict = "unmeasurable";
      reason = "clock uncertainty is comparable to the threshold itself";
    }
    rows.push({
      threshold_ms: threshold,
      uncertainty_band_ms: band,
      resolution_ratio: ratio,
      verdict,
      reason,
    });
  }

  return {
    cross_domain_sync_status: profile.cross_domain_sync_status,
    max_abs_offset_ms: bound,
    thresholds: rows,
    // The smallest threshold this profile could resolve cleanly.
    minimum_measurable_threshold_ms: trusted
      ? (2 * bound!) / CLEAN_RESOLUTION_RATIO
      : null,
    all_measurable: rows.every((row) => row.verdict === "clean"),
    worst_verdict: rows.some((row) => row.verdict === "unmeasurable")
      ? "unmeasurable"
      : rows.some((row) => row.verdict === "marginal")
        ? "marginal"
        : "clean",
  };
}

/**
 * Evaluate a latency objective, counting the uncertain events both ways.
 *
 * `undecided` is the verdict that earns this function its place: the answer flips
 * depending on how the unresolved readings are counted, so the honest report is that
 * the SLO was not measured — not that it passed.
 */
export function sloReport(
  result: unknown,
  objectiveMs: number,
  targetShare = 0.99,
): SloReport {
  const diagnosis = requireResult(result);
  if (typeof objectiveMs !== "number" || !Number.isFinite(objectiveMs) || objectiveMs <= 0) {
    throw new Error("objective_ms must be a positive number");
  }
  if (!(targetShare > 0) || targetShare > 1) {
    throw new Error("target_share must be in (0, 1]");
  }

  const rows = diagnosis.events;
  const total = rows.length;
  if (total === 0) throw new Error("result contains no events");

  let classifiedPass = 0;
  let classifiedFail = 0;
  let unresolved = 0;
  for (const row of rows) {
    if (ELIGIBLE_STATUSES.has(row.status)) {
      if (row.observed_transport_latency_ms < objectiveMs) classifiedPass += 1;
      else classifiedFail += 1;
    } else {
      // Not a pass and not a fail — the reading could not be trusted at all.
      unresolved += 1;
    }
  }

  const bestShare = (classifiedPass + unresolved) / total;
  const worstShare = classifiedPass / total;
  const bestMeets = bestShare >= targetShare;
  const worstMeets = worstShare >= targetShare;

  let verdict: SloReport["verdict"];
  let decidableBy: string | null;
  if (bestMeets && worstMeets) {
    verdict = "met";
    decidableBy = null;
  } else if (!bestMeets && !worstMeets) {
    verdict = "breached";
    decidableBy = null;
  } else {
    verdict = "undecided";
    decidableBy =
      "tightening the clock bound, or resolving the untrusted events, so the " +
      `${unresolved} unresolved reading(s) fall on one side`;
  }

  return {
    objective_ms: objectiveMs,
    target_share: targetShare,
    total_events: total,
    passing: classifiedPass,
    failing: classifiedFail,
    unresolved,
    best_case_share: bestShare,
    worst_case_share: worstShare,
    verdict,
    decidable_by: decidableBy,
    // The naive figure, over classified events only — reported so the gap to
    // worst_case_share is visible rather than inferred.
    naive_share:
      classifiedPass + classifiedFail
        ? classifiedPass / (classifiedPass + classifiedFail)
        : null,
  };
}

/**
 * Re-diagnose the batch across candidate clock bounds and report the status mix.
 *
 * If the `critical` count barely moves while `threshold_uncertain` collapses, the
 * latency was always there and your clocks were hiding it.
 */
export function clockErrorImpact(
  events: Iterable<unknown>,
  clockProfile: unknown,
  candidateBoundsMs: Iterable<number>,
  warningMs = 5.0,
  criticalMs = 15.0,
): ImpactPoint[] {
  const profile = validateClockProfile(clockProfile);
  const eventList = [...events];
  if (eventList.length === 0) throw new Error("events must not be empty");
  const bounds = [...candidateBoundsMs].map(Number);
  if (bounds.length === 0) throw new Error("candidate_bounds_ms must not be empty");
  if (bounds.some((value) => !(value >= 0))) {
    throw new Error("candidate bounds must be non-negative");
  }

  return bounds.map((bound) => {
    const candidateProfile = { ...profile, max_abs_offset_ms: bound };
    const diagnosed = eventList.map((event) =>
      diagnoseEvent(event, candidateProfile, warningMs, criticalMs),
    );
    const counts: Record<string, number> = {};
    for (const status of STATUSES) {
      counts[status] = diagnosed.filter((row) => row.status === status).length;
    }
    const eligible = diagnosed.filter((row) => row.eligible_for_transport_summary).length;
    return {
      max_abs_offset_ms: bound,
      counts,
      eligible,
      eligible_share: eligible / diagnosed.length,
      uncertain: counts.threshold_uncertain!,
    };
  });
}

/**
 * Split the observed latency into transport and processing.
 *
 * Both over eligible events only, side by side because the comparison is the point:
 * transport latency is somebody else's network, processing latency is your own handler.
 *
 * Note the asymmetry: processing latency is measured entirely on **your own** clock, so
 * it carries no cross-domain uncertainty at all — the more trustworthy of the two even
 * though it is usually the smaller.
 */
export function latencyBreakdown(result: unknown): LatencyBreakdown {
  const diagnosis = requireResult(result);
  const eligible = diagnosis.events.filter((row) => row.eligible_for_transport_summary);

  if (eligible.length === 0) {
    return {
      eligible_events: 0,
      transport: null,
      processing: null,
      end_to_end: null,
      processing_share_of_p50: null,
    };
  }

  const stats = (key: keyof typeof eligible[number]): LatencyStats => {
    const values = eligible.map((row) => Number(row[key]));
    return {
      p50_ms: percentile(values, 0.5),
      p95_ms: percentile(values, 0.95),
      p99_ms: percentile(values, 0.99),
      max_ms: Math.max(...values),
      min_ms: Math.min(...values),
    };
  };

  const transport = stats("observed_transport_latency_ms");
  const processing = stats("processing_latency_ms");
  const endToEnd = stats("observed_end_to_end_latency_ms");

  return {
    eligible_events: eligible.length,
    transport,
    processing,
    end_to_end: endToEnd,
    // Above ~0.5 the bottleneck is inside your own process, not the network.
    processing_share_of_p50: endToEnd.p50_ms ? processing.p50_ms / endToEnd.p50_ms : null,
  };
}
