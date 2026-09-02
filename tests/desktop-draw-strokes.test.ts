// Draw-mode stroke model: pure geometry, no DOM (embedded browser rework).

import { test, expect } from "bun:test";
import {
  strokeBounds,
  paintStroke,
  type DrawStroke,
  type DrawableContext,
} from "../desktop/src/shared/draw-strokes.ts";

// ----- strokeBounds -----

test("strokeBounds: freehand bbox covers every recorded point", () => {
  const stroke: DrawStroke = {
    tool: "freehand",
    points: [
      { x: 10, y: 20 },
      { x: 5, y: 40 },
      { x: 30, y: 15 },
    ],
  };
  expect(strokeBounds(stroke)).toEqual({ x: 5, y: 15, width: 25, height: 25 });
});

test("strokeBounds: circle bbox uses only the first and last point -- a midpoint outside that box is ignored", () => {
  const stroke: DrawStroke = {
    tool: "circle",
    points: [
      { x: 10, y: 10 },
      { x: 1000, y: 1000 }, // would blow up the bbox if it counted
      { x: 50, y: 40 },
    ],
  };
  expect(strokeBounds(stroke)).toEqual({ x: 10, y: 10, width: 40, height: 30 });
});

test("strokeBounds: circle bbox handles first/last in either order (drag going up-left)", () => {
  const stroke: DrawStroke = {
    tool: "circle",
    points: [
      { x: 50, y: 40 },
      { x: 10, y: 10 },
    ],
  };
  expect(strokeBounds(stroke)).toEqual({ x: 10, y: 10, width: 40, height: 30 });
});

test("strokeBounds: null on fewer than 2 points", () => {
  expect(strokeBounds({ tool: "freehand", points: [] })).toBeNull();
  expect(strokeBounds({ tool: "freehand", points: [{ x: 1, y: 1 }] })).toBeNull();
  expect(strokeBounds({ tool: "circle", points: [{ x: 1, y: 1 }] })).toBeNull();
});

test("strokeBounds: null when any bounding point is NaN", () => {
  const stroke: DrawStroke = {
    tool: "freehand",
    points: [
      { x: 0, y: 0 },
      { x: NaN, y: 10 },
    ],
  };
  expect(strokeBounds(stroke)).toBeNull();
});

test("strokeBounds: null when any bounding point is Infinity", () => {
  const stroke: DrawStroke = {
    tool: "freehand",
    points: [
      { x: 0, y: 0 },
      { x: Infinity, y: 10 },
    ],
  };
  expect(strokeBounds(stroke)).toBeNull();
});

test("strokeBounds: a NaN midpoint of a freehand stroke is rejected (every point matters, not just first/last)", () => {
  const stroke: DrawStroke = {
    tool: "freehand",
    points: [
      { x: 0, y: 0 },
      { x: NaN, y: 5 },
      { x: 10, y: 10 },
    ],
  };
  expect(strokeBounds(stroke)).toBeNull();
});

test("strokeBounds: a NaN circle midpoint (not first/last) does NOT reject -- only first/last are the bounding set", () => {
  const stroke: DrawStroke = {
    tool: "circle",
    points: [
      { x: 0, y: 0 },
      { x: NaN, y: NaN },
      { x: 10, y: 10 },
    ],
  };
  expect(strokeBounds(stroke)).toEqual({ x: 0, y: 0, width: 10, height: 10 });
});

test("strokeBounds: sub-pixel extents round outward and floor at 1", () => {
  const stroke: DrawStroke = {
    tool: "freehand",
    points: [
      { x: 10.2, y: 10.2 },
      { x: 10.6, y: 10.6 },
    ],
  };
  // floor(10.2)=10, ceil(10.6)=11 -> width/height 1, not 0.
  expect(strokeBounds(stroke)).toEqual({ x: 10, y: 10, width: 1, height: 1 });
});

test("strokeBounds: a perfectly straight (zero-height) drag still yields height >= 1", () => {
  const stroke: DrawStroke = {
    tool: "freehand",
    points: [
      { x: 0, y: 5 },
      { x: 20, y: 5 },
    ],
  };
  expect(strokeBounds(stroke)).toEqual({ x: 0, y: 5, width: 20, height: 1 });
});

test("strokeBounds: negative coordinates (drawn partially off-viewport) are legitimate", () => {
  const stroke: DrawStroke = {
    tool: "freehand",
    points: [
      { x: -10, y: -5 },
      { x: 10, y: 5 },
    ],
  };
  expect(strokeBounds(stroke)).toEqual({ x: -10, y: -5, width: 20, height: 10 });
});

// ----- paintStroke -----

/** A minimal fake 2D-context that records every call, for assertion. */
function fakeCtx(): DrawableContext & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    beginPath() {
      calls.push("beginPath");
    },
    moveTo(x, y) {
      calls.push(`moveTo(${x},${y})`);
    },
    lineTo(x, y) {
      calls.push(`lineTo(${x},${y})`);
    },
    stroke() {
      calls.push("stroke");
    },
    ellipse(x, y, rx, ry, rot, start, end) {
      calls.push(`ellipse(${x},${y},${rx},${ry},${rot},${start},${end})`);
    },
  };
}

test("paintStroke: freehand issues one moveTo then one lineTo per remaining point, then strokes", () => {
  const ctx = fakeCtx();
  const stroke: DrawStroke = {
    tool: "freehand",
    points: [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 0 },
    ],
  };
  paintStroke(ctx, stroke, 1, { color: "#ff0000", lineWidth: 3 });
  expect(ctx.calls).toEqual([
    "beginPath",
    "moveTo(0,0)",
    "lineTo(5,5)",
    "lineTo(10,0)",
    "stroke",
  ]);
  expect(ctx.strokeStyle).toBe("#ff0000");
  expect(ctx.lineWidth).toBe(3);
  expect(ctx.lineCap).toBe("round");
  expect(ctx.lineJoin).toBe("round");
});

test("paintStroke: freehand coordinates are multiplied by scale", () => {
  const ctx = fakeCtx();
  const stroke: DrawStroke = {
    tool: "freehand",
    points: [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ],
  };
  paintStroke(ctx, stroke, 2, { color: "#000", lineWidth: 1 });
  expect(ctx.calls).toEqual(["beginPath", "moveTo(2,4)", "lineTo(6,8)", "stroke"]);
});

test("paintStroke: circle draws one ellipse inscribed in the first/last bbox, centre + radii correct", () => {
  const ctx = fakeCtx();
  const stroke: DrawStroke = {
    tool: "circle",
    points: [
      { x: 10, y: 10 },
      { x: 50, y: 30 },
    ],
  };
  paintStroke(ctx, stroke, 1, { color: "#00f", lineWidth: 2 });
  // centre = ((10+50)/2, (10+30)/2) = (30, 20); rx = |50-10|/2 = 20; ry = |30-10|/2 = 10.
  expect(ctx.calls).toEqual([
    "beginPath",
    `ellipse(30,20,20,10,0,0,${Math.PI * 2})`,
    "stroke",
  ]);
});

test("paintStroke: circle ellipse ignores intermediate points entirely (only first/last matter, matching strokeBounds)", () => {
  const ctx = fakeCtx();
  const stroke: DrawStroke = {
    tool: "circle",
    points: [
      { x: 0, y: 0 },
      { x: 999, y: 999 },
      { x: 20, y: 10 },
    ],
  };
  paintStroke(ctx, stroke, 1, { color: "#000", lineWidth: 1 });
  expect(ctx.calls).toEqual(["beginPath", "ellipse(10,5,10,5,0,0,6.283185307179586)", "stroke"]);
});

test("paintStroke: circle centre/radii scale with `scale`", () => {
  const ctx = fakeCtx();
  const stroke: DrawStroke = {
    tool: "circle",
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ],
  };
  paintStroke(ctx, stroke, 3, { color: "#000", lineWidth: 1 });
  // centre (5,5) -> (15,15); rx=ry=5 -> 15.
  expect(ctx.calls).toEqual(["beginPath", "ellipse(15,15,15,15,0,0,6.283185307179586)", "stroke"]);
});

test("paintStroke: fewer than 2 points is a silent no-op", () => {
  const ctx = fakeCtx();
  paintStroke(ctx, { tool: "freehand", points: [] }, 1, { color: "#000", lineWidth: 1 });
  paintStroke(ctx, { tool: "freehand", points: [{ x: 1, y: 1 }] }, 1, {
    color: "#000",
    lineWidth: 1,
  });
  paintStroke(ctx, { tool: "circle", points: [{ x: 1, y: 1 }] }, 1, {
    color: "#000",
    lineWidth: 1,
  });
  expect(ctx.calls).toEqual([]);
});

// clampBoundsToBox: the persisted/reported region is the on-screen part of
// the stroke. Raw negative bounds are legitimate for the capture path but
// rejected by main's review-state validator (see that module's comment).
import { clampBoundsToBox } from "../desktop/src/shared/draw-strokes.ts";

test("clampBoundsToBox: bounds fully inside the box come back unchanged", () => {
  expect(clampBoundsToBox({ x: 10, y: 20, width: 30, height: 40 }, 800, 600)).toEqual({ x: 10, y: 20, width: 30, height: 40 });
});

test("clampBoundsToBox: a stroke started above/left of the canvas is cut at 0 and its size reduced accordingly", () => {
  expect(clampBoundsToBox({ x: -15, y: -5, width: 40, height: 20 }, 800, 600)).toEqual({ x: 0, y: 0, width: 25, height: 15 });
});

test("clampBoundsToBox: overflow past the right/bottom edge is cut at the box size", () => {
  expect(clampBoundsToBox({ x: 790, y: 590, width: 40, height: 40 }, 800, 600)).toEqual({ x: 790, y: 590, width: 10, height: 10 });
});

test("clampBoundsToBox: nothing visible, or a degenerate box, yields null", () => {
  expect(clampBoundsToBox({ x: -50, y: 10, width: 20, height: 20 }, 800, 600)).toBeNull();
  expect(clampBoundsToBox({ x: 10, y: 10, width: 20, height: 20 }, 0, 600)).toBeNull();
  expect(clampBoundsToBox({ x: 10, y: 10, width: 20, height: 20 }, Number.NaN, 600)).toBeNull();
});
