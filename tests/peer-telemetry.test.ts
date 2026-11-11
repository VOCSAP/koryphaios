import { describe, expect, test } from "bun:test";
import {
  PEER_TELEMETRY_CONTEXT_WINDOW_MAX,
  validatePeerTelemetrySnapshot,
  validateTileTelemetryRequest,
} from "../shared/peer-telemetry.ts";

describe("peer telemetry wire validation", () => {
  const snapshot = {
    model: "Claude Opus 4.6",
    modelId: "claude-opus-4-6",
    contextPct: 42.5,
    contextWindow: 200_000,
    observedAt: 1_731_234_567_890,
  };

  test("keeps nullable context values as null", () => {
    expect(validatePeerTelemetrySnapshot({ ...snapshot, contextPct: null, contextWindow: null })).toEqual({
      ...snapshot,
      contextPct: null,
      contextWindow: null,
    });
  });

  test("refuses non-finite and out-of-range numeric wire values", () => {
    for (const invalid of [NaN, Infinity, -Infinity, -0.01, 100.01]) {
      expect(validatePeerTelemetrySnapshot({ ...snapshot, contextPct: invalid })).toBeNull();
    }
    for (const invalid of [NaN, Infinity, 1.5, -1]) {
      expect(validatePeerTelemetrySnapshot({ ...snapshot, contextWindow: invalid })).toBeNull();
    }
  });

  test("refuses incorrectly typed or oversized model strings", () => {
    expect(validatePeerTelemetrySnapshot({ ...snapshot, model: 1 })).toBeNull();
    expect(validatePeerTelemetrySnapshot({ ...snapshot, modelId: "x".repeat(201) })).toBeNull();
  });

  test("requires a snapshot only for publish requests", () => {
    const common = {
      run_ref: "run-1",
      group_id: "group-1",
      desk_session: "desk-1",
      launch_hash: "a".repeat(64),
    };
    expect(validateTileTelemetryRequest({ ...common, action: "publish", snapshot })).toEqual({
      ...common,
      action: "publish",
      snapshot,
    });
    expect(validateTileTelemetryRequest({ ...common, action: "publish" })).toBeNull();
    expect(validateTileTelemetryRequest({ ...common, action: "stop" })).toEqual({ ...common, action: "stop" });
    expect(validateTileTelemetryRequest({ ...common, action: "stop", snapshot })).toBeNull();
  });

  const hostile: Array<[string, string]> = [
    ["LF", String.fromCharCode(0x0a)],
    ["CR", String.fromCharCode(0x0d)],
    ["ESC", String.fromCharCode(0x1b)],
    ["C1 control", String.fromCharCode(0x85)],
    ["line separator", String.fromCodePoint(0x2028)],
    ["paragraph separator", String.fromCodePoint(0x2029)],
    ["right-to-left override", String.fromCodePoint(0x202e)],
    ["bidi isolate", String.fromCodePoint(0x2066)],
    ["zero-width space", String.fromCodePoint(0x200b)],
    ["byte order mark", String.fromCodePoint(0xfeff)],
  ];

  test("refuses model and modelId carrying control, separator, bidi or zero-width characters", () => {
    for (const [name, ch] of hostile) {
      for (const field of ["model", "modelId"] as const) {
        const value = `${snapshot[field]}${ch}x`;
        expect(validatePeerTelemetrySnapshot({ ...snapshot, [field]: value }), `${field} with ${name}`).toBeNull();
      }
    }
  });

  test("accepts the display and id punctuation the Deck producer emits", () => {
    const middleDot = String.fromCodePoint(0xb7);
    const wire = { ...snapshot, model: `Opus 4.6 ${middleDot} 1M`, modelId: "claude-opus-4-1@20250805" };
    expect(validatePeerTelemetrySnapshot(wire)).toEqual(wire);
  });

  test("refuses a context window of zero or above the upper bound", () => {
    for (const invalid of [0, PEER_TELEMETRY_CONTEXT_WINDOW_MAX + 1]) {
      expect(validatePeerTelemetrySnapshot({ ...snapshot, contextWindow: invalid }), `window ${invalid}`).toBeNull();
    }
    expect(
      validatePeerTelemetrySnapshot({ ...snapshot, contextWindow: PEER_TELEMETRY_CONTEXT_WINDOW_MAX })?.contextWindow,
    ).toBe(PEER_TELEMETRY_CONTEXT_WINDOW_MAX);
  });

  test("refuses an observedAt that is not a non-negative safe integer", () => {
    for (const invalid of [NaN, Infinity, -Infinity, 1.5, -1]) {
      expect(validatePeerTelemetrySnapshot({ ...snapshot, observedAt: invalid }), `observedAt ${invalid}`).toBeNull();
    }
  });

  describe("request envelope", () => {
    const common = {
      run_ref: "run-1",
      group_id: "group-1",
      desk_session: "desk-1",
      launch_hash: "a".repeat(64),
    };
    const bodies: Array<[string, Record<string, unknown>]> = [
      ["publish", { action: "publish", snapshot }],
      ["stop", { action: "stop" }],
    ];

    test("refuses an invalid identifier on publish and stop", () => {
      for (const [name, tail] of bodies) {
        for (const field of ["run_ref", "group_id", "desk_session"] as const) {
          for (const invalid of ["", "x".repeat(129), 7, null]) {
            expect(
              validateTileTelemetryRequest({ ...common, ...tail, [field]: invalid }),
              `${name} ${field}=${String(invalid).slice(0, 8)}`,
            ).toBeNull();
          }
        }
      }
    });

    test("refuses a launch hash that is not 64 lowercase hex", () => {
      for (const [name, tail] of bodies) {
        for (const invalid of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "", 7]) {
          expect(
            validateTileTelemetryRequest({ ...common, ...tail, launch_hash: invalid }),
            `${name} launch_hash=${String(invalid).slice(0, 8)}`,
          ).toBeNull();
        }
      }
    });

    test("refuses an unknown or missing action", () => {
      for (const invalid of ["delete", "Publish", "", undefined, 1]) {
        expect(validateTileTelemetryRequest({ ...common, action: invalid, snapshot }), `action ${String(invalid)}`).toBeNull();
      }
    });
  });
});
