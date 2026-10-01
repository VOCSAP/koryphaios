import { describe, expect, mock, test } from "bun:test";
import type { AvatarFace } from "../desktop/src/shared/avatar-state.ts";
import * as geometry from "../desktop/src/shared/avatar-mask-geometry.ts";
import { avatarCssBlock, cssRules } from "./_avatar-css";

// Card 8fb62e61 caps a continuous loop at 4 repaints per second; held here, not read from the code under test.
const CONTRACT_MAX_STEPS_PER_SECOND = 4;
const STEPPED = "steps(var(--avatar-loop-steps))";

mock.module("@shared/avatar-mask-geometry", () => ({ ...geometry }));

const motion = await import("../desktop/src/renderer/src/avatar/motion");
const { FACE_LOOPS, MOTION_LIMITS, motionAttributes, motionMode, motionPlan } = motion;
type Input = Parameters<typeof motionPlan>[0];

const FACES = Object.keys(geometry.FACE_GEOMETRY) as AvatarFace[];
const CHOICES = ["continuous", "transitions", "none"] as const;

function input(partial: Partial<Input> = {}): Input {
  return { choice: "continuous", osReducedMotion: false, visible: true, dndActive: false, ...partial };
}

function other(face: AvatarFace): AvatarFace {
  return face === "endormi" ? "travaille" : "endormi";
}

describe("matrix: 3 choices x 2 OS preferences x 7 faces x visibility/DND x transition kinds", () => {
  for (const choice of CHOICES) {
    for (const osReducedMotion of [false, true]) {
      for (const face of FACES) {
        const label = `${choice} / os-reduced=${osReducedMotion} / ${face}`;

        test(`${label}: first paint and an identical face never animate`, () => {
          for (const previous of [null, face]) {
            const plan = motionPlan(input({ choice, osReducedMotion }), previous, face);
            expect(plan.transition, `${label} previous=${previous}`).toBe("none");
            expect(plan.transitionMs).toBe(0);
          }
        });

        test(`${label}: a face change follows the ADR table`, () => {
          const plan = motionPlan(input({ choice, osReducedMotion }), other(face), face);
          if (osReducedMotion) {
            expect(plan.mode).toBe("reduced");
            expect(plan.transition, "the OS preference must win over the menu choice").toBe("fade");
            expect(plan.transitionMs).toBeLessThanOrEqual(MOTION_LIMITS.fadeMs);
            expect(plan.loop).toBeNull();
          } else if (choice === "none") {
            expect(plan.transition).toBe("none");
            expect(plan.loop).toBeNull();
          } else {
            expect(plan.transition).toBe("animate");
            expect(plan.transitionMs).toBeGreaterThan(0);
            expect(plan.transitionMs).toBeLessThanOrEqual(MOTION_LIMITS.transitionMs);
            if (choice === "transitions") expect(plan.loop, "transitions mode must not loop").toBeNull();
          }
          if (face === "seul") expect(plan.loop, "Seul never breathes").toBeNull();
        });

        test(`${label}: hidden or DND suspends every animation`, () => {
          for (const state of [{ visible: false, dndActive: false }, { visible: true, dndActive: true }, { visible: false, dndActive: true }]) {
            const plan = motionPlan(input({ choice, osReducedMotion, ...state }), other(face), face);
            expect(plan.mode).toBe("suspended");
            expect(plan.loop).toBeNull();
            expect(plan.transition).toBe("none");
            expect(plan.transitionMs).toBe(0);
          }
        });
      }
    }
  }
});

describe("loops", () => {
  test("only continuous mode loops, and with the face's own loop", () => {
    for (const face of FACES) {
      expect(motionPlan(input(), face, face).loop).toEqual(FACE_LOOPS[face]);
      expect(motionPlan(input({ choice: "transitions" }), face, face).loop).toBeNull();
      expect(motionPlan(input({ choice: "none" }), face, face).loop).toBeNull();
    }
  });

  test("Seul never loops and Endormi breathes", () => {
    expect(FACE_LOOPS.seul).toBeNull();
    expect(FACE_LOOPS.endormi).not.toBeNull();
  });

  test("every loop is stepped under the repaint cap", () => {
    for (const [face, loop] of Object.entries(FACE_LOOPS)) {
      if (loop === null) continue;
      const perSecond = (loop.steps * 1000) / loop.durationMs;
      expect(perSecond, `${face} repaints ${perSecond}/s`).toBeLessThanOrEqual(CONTRACT_MAX_STEPS_PER_SECOND);
      expect(loop.steps).toBeGreaterThanOrEqual(1);
    }
    expect(MOTION_LIMITS.maxStepsPerSecond).toBeLessThanOrEqual(CONTRACT_MAX_STEPS_PER_SECOND);
  });

  test("every infinite animation of the avatar stylesheet runs in the container's steps", () => {
    const infinite = cssRules(avatarCssBlock())
      .filter((rule) => rule.atRule === null)
      .flatMap((rule) => rule.body.split(";").map((declaration) => ({ selector: rule.selectors.join(", "), declaration: declaration.trim() })))
      .filter(({ declaration }) => /\binfinite\b/.test(declaration));
    expect(infinite.length, "no looping animation found in the avatar block").toBeGreaterThan(0);
    for (const { selector, declaration } of infinite) {
      expect(declaration, `${selector} loops without the stepped timing`).toContain(STEPPED);
    }
  });
});

describe("halo and priority", () => {
  test("DND cuts the halo without changing the face, hiding keeps it", () => {
    expect(motionPlan(input(), null, "reclame").halo).toBe(true);
    expect(motionPlan(input({ dndActive: true }), null, "reclame").halo).toBe(false);
    expect(motionPlan(input({ visible: false }), null, "reclame").halo).toBe(true);
    expect(motionPlan(input(), null, "travaille").halo).toBe(false);
  });

  test("priority is hidden/DND, then OS, then the menu choice", () => {
    expect(motionMode(input({ visible: false, osReducedMotion: true, choice: "none" }))).toBe("suspended");
    expect(motionMode(input({ dndActive: true, osReducedMotion: true }))).toBe("suspended");
    expect(motionMode(input({ osReducedMotion: true, choice: "none" }))).toBe("reduced");
    for (const choice of CHOICES) expect(motionMode(input({ choice }))).toBe(choice);
  });
});

describe("container attributes", () => {
  test("a loop plan carries its period and steps, a still plan turns everything off", () => {
    const looping = motionAttributes(motionPlan(input(), null, "endormi"));
    expect(looping.data["data-loop"]).toBe("on");
    expect(looping.vars["--avatar-loop-ms"]).toBe(`${FACE_LOOPS.endormi.durationMs}ms`);
    expect(looping.vars["--avatar-loop-steps"]).toBe(String(FACE_LOOPS.endormi.steps));

    const still = motionAttributes(motionPlan(input({ dndActive: true }), "travaille", "reclame"));
    expect(still.data).toEqual({ "data-loop": "off", "data-transition": "none", "data-halo": "off" });
  });

  test("a reduced-motion face change exposes a fade of at most 200 ms", () => {
    const attrs = motionAttributes(motionPlan(input({ osReducedMotion: true }), "endormi", "reclame"));
    expect(attrs.data["data-transition"]).toBe("fade");
    expect(attrs.vars["--avatar-transition-ms"]).toBe(`${MOTION_LIMITS.fadeMs}ms`);
  });
});
