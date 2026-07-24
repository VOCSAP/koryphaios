// Browser-view REC feature: pure helpers (container pick, crop math, names).

import { test, expect } from "bun:test";
import {
  computeCropRect,
  formatElapsed,
  pickRecorderMime,
  recordingFileName
} from "../desktop/src/shared/recording.ts";

test("pickRecorderMime prefers mp4, falls back to webm, null when nothing", () => {
  expect(pickRecorderMime(() => true)).toEqual({ mime: "video/mp4;codecs=avc1", ext: "mp4" });
  expect(pickRecorderMime((m) => m.startsWith("video/webm"))).toEqual({
    mime: "video/webm;codecs=vp9",
    ext: "webm"
  });
  expect(pickRecorderMime((m) => m === "video/webm")).toEqual({ mime: "video/webm", ext: "webm" });
  expect(pickRecorderMime(() => false)).toBeNull();
});

test("computeCropRect maps CSS px to video px and absorbs top chrome", () => {
  // 2x scale capture, 40 video-px of title bar above the client area.
  const r = computeCropRect(2000, 1240, 1000, 600, { left: 100, top: 50, width: 400, height: 300 });
  expect(r).toEqual({ sx: 200, sy: 140, sw: 800, sh: 600 });
});

test("computeCropRect clamps to the frame and rejects degenerate inputs", () => {
  const r = computeCropRect(1000, 600, 1000, 600, { left: 800, top: 400, width: 400, height: 400 });
  expect(r).toEqual({ sx: 800, sy: 400, sw: 200, sh: 200 });
  expect(computeCropRect(0, 600, 1000, 600, { left: 0, top: 0, width: 10, height: 10 })).toBeNull();
  expect(computeCropRect(1000, 600, 1000, 600, { left: 0, top: 0, width: 0, height: 10 })).toBeNull();
  // Rect entirely outside the frame → nothing sensible to crop.
  expect(
    computeCropRect(1000, 600, 1000, 600, { left: 1000, top: 0, width: 5, height: 5 })
  ).toBeNull();
});

test("recordingFileName stamps like annotations, formatElapsed is m:ss", () => {
  const name = recordingFileName("webm", new Date("2026-07-23T14:05:12.345Z"));
  expect(name).toBe("recording-2026-07-23T14-05-12.webm");
  expect(formatElapsed(0)).toBe("0:00");
  expect(formatElapsed(59_400)).toBe("0:59");
  expect(formatElapsed(61_000)).toBe("1:01");
  expect(formatElapsed(-5)).toBe("0:00");
});
