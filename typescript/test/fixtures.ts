/** Shared fixture access. The same JSON backs the Python suite. */

import { createRequire } from "node:module";

import {
  type ClockProfile,
  type LatencyEvent,
  type MonitorResult,
  monitor,
} from "../src/core.ts";

const require = createRequire(import.meta.url);
const FIXTURE = require("./fixtures/fixtures.json") as {
  thresholds_ms: { warning: number; critical: number };
  clock_profile: ClockProfile;
  events: Array<LatencyEvent & { expected_status: string }>;
};

export const CLOCK_PROFILE = FIXTURE.clock_profile;
export const EVENTS = FIXTURE.events;
export const WARNING_MS = FIXTURE.thresholds_ms.warning;
export const CRITICAL_MS = FIXTURE.thresholds_ms.critical;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const profile = (overrides: Record<string, unknown> = {}): ClockProfile => ({
  ...clone(CLOCK_PROFILE),
  ...overrides,
});

export const events = (...indexes: number[]): LatencyEvent[] =>
  indexes.length === 0 ? clone(EVENTS) : indexes.map((index) => clone(EVENTS[index]!));

/** A timestamp offset from a fixed base by whole microseconds. */
export const at = (microseconds: number): string => {
  const whole = 13 * 3_600_000_000 + 30 * 60_000_000 + microseconds;
  const hours = Math.floor(whole / 3_600_000_000);
  let rest = whole % 3_600_000_000;
  const minutes = Math.floor(rest / 60_000_000);
  rest %= 60_000_000;
  const seconds = Math.floor(rest / 1_000_000);
  const micros = rest % 1_000_000;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `2026-07-13T${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(micros, 6)}Z`;
};

/** A minimal 1ms-transport, 1ms-processing event. */
export const event = (overrides: Partial<LatencyEvent> = {}): LatencyEvent => ({
  event_id: "E1",
  sequence: 1,
  event_time: at(0),
  receive_time: at(1000),
  process_time: at(2000),
  ...overrides,
});

/** An event with a given transport and processing latency, in milliseconds. */
export const spaced = (
  transportMs: number,
  processingMs = 1.0,
  overrides: Partial<LatencyEvent> = {},
): LatencyEvent =>
  event({
    event_time: at(0),
    receive_time: at(Math.round(transportMs * 1000)),
    process_time: at(Math.round((transportMs + processingMs) * 1000)),
    ...overrides,
  });

export const run = (
  rows?: unknown[] | null,
  clockProfile?: unknown,
  warningMs?: number,
  criticalMs?: number,
): MonitorResult =>
  monitor(
    rows ?? events(),
    clockProfile ?? profile(),
    warningMs ?? WARNING_MS,
    criticalMs ?? CRITICAL_MS,
  );

/** A monitored batch built from transport latencies. */
export const batch = (
  transports: number[],
  clockProfile?: unknown,
): MonitorResult =>
  monitor(
    transports.map((value, index) =>
      spaced(value, 1.0, { event_id: `E${index}`, sequence: index }),
    ),
    clockProfile ?? profile(),
    WARNING_MS,
    CRITICAL_MS,
  );
