// Element-pick screenshot crop math (Chantier OD4): pure, no DOM.

import { test, expect } from "bun:test";
import {
  computeBoxCropRect,
  computeElementCropRect,
  PICK_SHOT_MAX_BYTES,
} from "../desktop/src/shared/pick-shot.ts";

test("computeElementCropRect: nominal 1x scale includes the 8px padding", () => {
  const r = computeElementCropRect({ x: 100, y: 50, width: 200, height: 100 }, 1000, 800, 1000);
  expect(r).toEqual({ sx: 92, sy: 42, sw: 216, sh: 116 });
});

test("computeElementCropRect: 2x scale (retina) scales both rect and padding", () => {
  const r = computeElementCropRect({ x: 100, y: 50, width: 200, height: 100 }, 2000, 1600, 1000);
  expect(r).toEqual({ sx: 184, sy: 84, sw: 432, sh: 232 });
});

test("computeElementCropRect: padding clamped when it overruns the image edge", () => {
  // Element near the top-left corner: padding would go negative, clamped to 0.
  const r = computeElementCropRect({ x: 2, y: 3, width: 50, height: 20 }, 1000, 800, 1000);
  expect(r).toEqual({ sx: 0, sy: 0, sw: 60, sh: 31 });
});

test("computeElementCropRect: NaN/undefined/negative inputs return null", () => {
  expect(computeElementCropRect({ x: NaN, y: 0, width: 10, height: 10 }, 1000, 800, 1000)).toBeNull();
  expect(computeElementCropRect({ x: 0, y: 0, width: NaN, height: 10 }, 1000, 800, 1000)).toBeNull();
  expect(computeElementCropRect({ x: undefined, y: undefined, width: 10, height: 10 }, 1000, 800, 1000)).toBeNull();
  expect(computeElementCropRect({ x: 0, y: 0, width: 10, height: 10 }, NaN, 800, 1000)).toBeNull();
  expect(computeElementCropRect({ x: 0, y: 0, width: 10, height: 10 }, 1000, 800, NaN)).toBeNull();
  // Negative width/height: getBoundingClientRect never yields these, so a
  // negative value is malformed data, rejected outright regardless of padding.
  expect(computeElementCropRect({ x: 0, y: 0, width: -10, height: 10 }, 1000, 800, 1000)).toBeNull();
  expect(computeElementCropRect({ x: 0, y: 0, width: 10, height: -10 }, 1000, 800, 1000)).toBeNull();
});

test("computeElementCropRect: negative x/y (partially scrolled off-screen) is legitimate, not rejected", () => {
  expect(computeElementCropRect({ x: -10, y: -10, width: 30, height: 30 }, 1000, 800, 1000)).not.toBeNull();
});

test("computeElementCropRect: zero or negative viewport width returns null", () => {
  expect(computeElementCropRect({ x: 0, y: 0, width: 10, height: 10 }, 1000, 800, 0)).toBeNull();
  expect(computeElementCropRect({ x: 0, y: 0, width: 10, height: 10 }, 1000, 800, -1)).toBeNull();
});

test("computeElementCropRect: element fully outside the image returns null", () => {
  expect(computeElementCropRect({ x: 5000, y: 5000, width: 20, height: 20 }, 1000, 800, 1000)).toBeNull();
  expect(computeElementCropRect({ x: -5000, y: -5000, width: 20, height: 20 }, 1000, 800, 1000)).toBeNull();
});

test("computeElementCropRect: degenerate rect (negative size beyond padding) returns null", () => {
  expect(computeElementCropRect({ x: 0, y: 0, width: -1000, height: 20 }, 1000, 800, 1000)).toBeNull();
  expect(computeElementCropRect({ x: 0, y: 0, width: 20, height: -1000 }, 1000, 800, 1000)).toBeNull();
});

test("PICK_SHOT_MAX_BYTES is a sane positive constant", () => {
  expect(PICK_SHOT_MAX_BYTES).toBeGreaterThan(0);
  expect(PICK_SHOT_MAX_BYTES).toBe(2 * 1024 * 1024);
});

// ----- computeBoxCropRect (draw-mode region crop, generalized from the
// element crop above -- shared/draw-strokes.ts's StrokeBounds is the same
// {x,y,width,height} shape) -----

test("computeBoxCropRect: identical result to computeElementCropRect for a box equal to a pick's rect", () => {
  const rect = { x: 100, y: 50, width: 200, height: 100 };
  const fromBox = computeBoxCropRect(rect, 1000, 800, 1000);
  const fromPick = computeElementCropRect(rect, 1000, 800, 1000);
  expect(fromBox).toEqual(fromPick);
  expect(fromBox).toEqual({ sx: 92, sy: 42, sw: 216, sh: 116 });
});

test("computeBoxCropRect: NaN box returns null", () => {
  expect(computeBoxCropRect({ x: NaN, y: 0, width: 10, height: 10 }, 1000, 800, 1000)).toBeNull();
  expect(computeBoxCropRect({ x: 0, y: NaN, width: 10, height: 10 }, 1000, 800, 1000)).toBeNull();
  expect(computeBoxCropRect({ x: 0, y: 0, width: NaN, height: 10 }, 1000, 800, 1000)).toBeNull();
  expect(computeBoxCropRect({ x: 0, y: 0, width: 10, height: NaN }, 1000, 800, 1000)).toBeNull();
});

test("computeElementCropRect delegates to computeBoxCropRect: negative width/height still rejected", () => {
  expect(computeElementCropRect({ x: 0, y: 0, width: -10, height: 10 }, 1000, 800, 1000)).toBeNull();
});
