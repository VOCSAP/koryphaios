import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Root } from "../desktop/tests-support/react-test-harness";
import { AvatarState, type AvatarDeckCounters, type AvatarDeckIdentity, type AvatarFace, type AvatarSummary } from "../desktop/src/shared/avatar-state.ts";
import * as geometry from "../desktop/src/shared/avatar-mask-geometry.ts";
import { AVATAR_DOCUMENT_SELECTORS, avatarCssBlock, cssRules, declarationValues, unrootedSelectors } from "./_avatar-css";

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const { act, React, createRoot } = await import("../desktop/tests-support/react-test-harness");

// bun does not resolve the tsconfig-only `@shared/*` alias from the repo root.
mock.module("@shared/avatar-mask-geometry", () => ({ ...geometry }));

const skins = await import("../desktop/src/renderer/src/avatar/skins");
const { AVATAR_SKINS, avatarFaceText, avatarThemeVars } = skins;
const AVATAR_FACES: AvatarFace[] = skins.AVATAR_FACES;
const { deckIdentityKey } = await import("../desktop/src/renderer/src/avatar/MaskSkin");

const DESKTOP_SRC = join(import.meta.dir, "..", "desktop", "src");
const SKIN_REGISTRY = join(DESKTOP_SRC, "renderer", "src", "avatar", "skins.ts");
const STYLES = join(DESKTOP_SRC, "renderer", "src", "styles.css");

const BROKER = "http://127.0.0.1:7899";
const OTHER_BROKER = "http://127.0.0.1:7900";
const DECK_A: AvatarDeckIdentity = { deckRunId: "run-a", broker_url: BROKER };
const DECK_B: AvatarDeckIdentity = { deckRunId: "run-b", broker_url: BROKER };

function counters(partial: Partial<AvatarDeckCounters> = {}): AvatarDeckCounters {
  return { working: 0, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0, ...partial };
}

function produced(build: (state: AvatarState, clock: { now: number }) => void): AvatarSummary {
  const clock = { now: 1_000_000 };
  const state = new AvatarState({ now: () => clock.now });
  build(state, clock);
  return state.summary();
}

function decks(count: number, kinds: Partial<AvatarDeckCounters>[]): AvatarSummary {
  return produced((s) => {
    for (let i = 0; i < count; i++) {
      s.receiveSnapshot({ identity: { deckRunId: `run-${i}`, broker_url: BROKER }, counters: counters(kinds[i % kinds.length]), unread: 0 });
    }
  });
}

const SCENARIOS: Record<AvatarFace, () => AvatarSummary> = {
  seul: () => produced(() => {}),
  endormi: () => produced((s) => s.receiveSnapshot({ identity: DECK_A, counters: counters({ idle: 2 }), unread: 0 })),
  travaille: () =>
    produced((s) => {
      s.receiveSnapshot({ identity: DECK_A, counters: counters({ working: 2 }), unread: 0 });
      s.receiveSnapshot({ identity: DECK_B, counters: counters({ idle: 1 }), unread: 0 });
    }),
  courrier: () => produced((s) => s.receiveSnapshot({ identity: DECK_A, counters: counters({ idle: 1 }), unread: 3 })),
  perdu: () =>
    produced((s) => {
      s.receiveSnapshot({ identity: DECK_A, counters: counters({ exited: 1 }), unread: 0 });
      s.receiveSnapshot({ identity: DECK_B, counters: counters({ rateLimited: 1 }), unread: 0 });
    }),
  reclame: () =>
    produced((s) => {
      s.receiveSnapshot({ identity: DECK_A, counters: counters({ waiting: 2, working: 1 }), unread: 3 });
      s.receiveSnapshot({ identity: DECK_B, counters: counters({ exited: 1 }), unread: 0 });
    }),
  panne: () =>
    produced((s, clock) => {
      s.receiveSnapshot({ identity: DECK_B, counters: counters({ working: 1 }), unread: 0 });
      clock.now += 20_000;
      s.receiveSnapshot({ identity: DECK_A, counters: counters({ working: 1 }), unread: 0 });
    })
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

type Skin = (props: { summary: AvatarSummary }) => React.JSX.Element;

function render(skin: Skin, summary: AvatarSummary): SVGSVGElement {
  act(() => root.render(React.createElement(skin, { summary })));
  const svg = container.querySelector("svg.avatar-skin");
  if (!svg) throw new Error("the skin rendered no svg.avatar-skin");
  return svg as SVGSVGElement;
}

function drawingSignature(svg: SVGSVGElement): string {
  const ink = svg.querySelector(".avatar-ink");
  if (!ink) throw new Error("the skin has no ink layer");
  const parts = [...ink.querySelectorAll(".avatar-opening, .avatar-brow, .avatar-crack")].map((el) => el.getAttribute("d"));
  const gaze = [...ink.querySelectorAll(".avatar-gaze")].map((el) => `${el.getAttribute("cx")},${el.getAttribute("cy")}`);
  const tilt = svg.querySelector(".avatar-face")?.parentElement?.getAttribute("transform") ?? "";
  return JSON.stringify({ parts, gaze, tilt });
}

function markers(svg: SVGSVGElement): { deck: string; kind: string }[] {
  return [...svg.querySelectorAll("[data-deck]")].map((el) => ({ deck: el.getAttribute("data-deck")!, kind: el.getAttribute("data-kind")! }));
}

function overflow(svg: SVGSVGElement): number {
  return Number(svg.querySelector("[data-overflow]")?.getAttribute("data-overflow") ?? 0);
}

const keyOf = (identity: AvatarDeckIdentity): string => JSON.stringify([identity.deckRunId, identity.broker_url]);
const byDeck = (list: { deck: string; kind: string }[]) => [...list].sort((a, b) => a.deck.localeCompare(b.deck));

describe("domain", () => {
  test("every face of the closed domain has a producer scenario that really yields it", () => {
    expect(Object.keys(SCENARIOS).sort(), "a face of AVATAR_FACES has no scenario, so no skin is checked on it").toEqual([...AVATAR_FACES].sort());
    for (const face of AVATAR_FACES) expect(SCENARIOS[face]().face, `the ${face} scenario produced another face`).toBe(face);
  });

  test("at least one skin is registered", () => {
    expect(Object.keys(AVATAR_SKINS).length).toBeGreaterThan(0);
  });
});

for (const [skinId, skin] of Object.entries(AVATAR_SKINS) as [string, Skin][]) {
  describe(`skin ${skinId}`, () => {
    for (const face of AVATAR_FACES) {
      test(`renders ${face} with its own text`, () => {
        const summary = SCENARIOS[face]();
        const svg = render(skin, summary);
        expect(svg.getAttribute("data-face")).toBe(face);
        expect(svg.querySelectorAll(".avatar-ink .avatar-outline").length, "the mask outline is missing").toBe(1);
        expect(svg.querySelectorAll(".avatar-ink .avatar-opening").length, "eyes and mouth must be three openings, never a bare line").toBe(3);
        expect(markers(svg).map((p) => p.deck).sort(), "one marker per deck, keyed by its identity").toEqual(summary.decks.map(deckIdentityKey).sort());
        const text = avatarFaceText(summary);
        expect(text.key).toBe(`avatar.face.${face}`);
        for (const value of Object.values(text.params)) expect(Number.isFinite(value)).toBe(true);
      });
    }

    test("the seven faces are seven different drawings", () => {
      const signatures = AVATAR_FACES.map((face) => drawingSignature(render(skin, SCENARIOS[face]())));
      expect(new Set(signatures).size, "two faces share a drawing").toBe(AVATAR_FACES.length);
    });

    test("Reclame takes the face but keeps the unread badge and the lost deck", () => {
      const svg = render(skin, SCENARIOS.reclame());
      const waiting = svg.querySelector(".avatar-badge.is-waiting");
      expect(waiting?.getAttribute("data-count")).toBe("2");
      expect(waiting?.textContent).toBe("2");
      expect(svg.querySelector(".avatar-badge.is-unread")?.getAttribute("data-count"), "the unread badge vanished under Reclame").toBe("3");
      expect(markers(svg)).toContainEqual({ deck: keyOf(DECK_B), kind: "lost" });
    });

    test("Courrier comes from a snapshot's unread count, with its badge and no waiting badge", () => {
      const svg = render(skin, SCENARIOS.courrier());
      expect(svg.getAttribute("data-face")).toBe("courrier");
      expect(svg.querySelector(".avatar-badge.is-unread")?.getAttribute("data-count")).toBe("3");
      expect(svg.querySelector(".avatar-badge.is-waiting")).toBeNull();
    });

    test("each deck gets the marker of its own condition", () => {
      expect(byDeck(markers(render(skin, SCENARIOS.panne()))), "Panne of one deck must keep the other working").toEqual(
        byDeck([
          { deck: keyOf(DECK_B), kind: "fault" },
          { deck: keyOf(DECK_A), kind: "working" }
        ])
      );
      expect(byDeck(markers(render(skin, SCENARIOS.perdu())))).toEqual(
        byDeck([
          { deck: keyOf(DECK_A), kind: "lost" },
          { deck: keyOf(DECK_B), kind: "quota" }
        ])
      );
      const both = produced((s) => s.receiveSnapshot({ identity: DECK_A, counters: counters({ exited: 1, rateLimited: 2 }), unread: 0 }));
      expect(markers(render(skin, both)), "exited and rate-limited at once is lost").toEqual([{ deck: keyOf(DECK_A), kind: "lost" }]);
    });

    test("markers follow the deck identity pair, not the order or the run id alone", () => {
      const sameRun = { deckRunId: "run-a", broker_url: OTHER_BROKER };
      const forward = produced((s) => {
        s.receiveSnapshot({ identity: DECK_A, counters: counters({ working: 1 }), unread: 0 });
        s.receiveSnapshot({ identity: sameRun, counters: counters({ exited: 1 }), unread: 0 });
      });
      const backward = produced((s) => {
        s.receiveSnapshot({ identity: sameRun, counters: counters({ exited: 1 }), unread: 0 });
        s.receiveSnapshot({ identity: DECK_A, counters: counters({ working: 1 }), unread: 0 });
      });
      const expected = byDeck([
        { deck: keyOf(DECK_A), kind: "working" },
        { deck: keyOf(sameRun), kind: "lost" }
      ]);
      expect(byDeck(markers(render(skin, forward)))).toEqual(expected);
      expect(byDeck(markers(render(skin, backward)))).toEqual(expected);
    });

    test("every deck is a marker or counted by the overflow, and a fault deck is never the one counted", () => {
      for (const count of [1, 6, 12, 13, 30]) {
        const svg = render(skin, decks(count, [{ idle: 1 }]));
        expect(markers(svg).length + overflow(svg), `${count} decks`).toBe(count);
      }
      const faulty = { deckRunId: "run-faulty", broker_url: OTHER_BROKER };
      const lastFaulty = produced((s) => {
        for (let i = 0; i < 15; i++) s.receiveSnapshot({ identity: { deckRunId: `run-${i}`, broker_url: BROKER }, counters: counters({ idle: 1 }), unread: 0 });
        s.receiveSnapshot({ identity: faulty, counters: counters({ working: 1 }), unread: 0 });
        s.setBrokerReachable(OTHER_BROKER, false);
      });
      expect(lastFaulty.decks.at(-1)?.identity, "the faulty deck must come last for this check to mean anything").toEqual(faulty);
      expect(markers(render(skin, lastFaulty))).toContainEqual({ deck: keyOf(faulty), kind: "fault" });
    });
  });
}

describe("mask skin geometry", () => {
  const skin = AVATAR_SKINS.mask as Skin;

  test("Panne cracks the mask and Reclame wears the halo", () => {
    expect(render(skin, SCENARIOS.panne()).querySelectorAll(".avatar-ink .avatar-crack").length).toBe(1);
    expect(render(skin, SCENARIOS.reclame()).querySelectorAll(".avatar-halo").length).toBe(1);
    expect(avatarFaceText(SCENARIOS.panne()).params).toEqual({ count: 1 });
    expect(avatarFaceText(SCENARIOS.perdu()).params).toEqual({ exited: 1, rateLimited: 1 });
  });

  test("the viewBox holds the mask, its underlay ring and the Reclame halo, tilted faces included", () => {
    const rules = cssRules(avatarCssBlock());
    const width = (selector: string): number => {
      const values = declarationValues(rules, selector, "stroke-width").map(Number);
      if (values.length === 0) throw new Error(`no stroke-width for ${selector} in the avatar block`);
      return Math.max(...values);
    };
    const underlay = width(".avatar-root .avatar-skin .avatar-under");
    const haloUnderlay = width(".avatar-root .avatar-skin .avatar-halo-under");
    const points = [...geometry.MASK_OUTLINE.matchAll(/(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
    const c = geometry.MASK_CENTER;
    const radius = Math.max(...points.map((p) => Math.hypot(p.x - c.x, p.y - c.y)));
    const box = geometry.FIGURE_VIEWBOX;
    for (const face of AVATAR_FACES) {
      const g = geometry.FACE_GEOMETRY[face];
      const shapes = [{ scale: 1, stroke: underlay }, ...(g.halo ? [{ scale: geometry.HALO_SCALE, stroke: haloUnderlay }] : [])];
      for (const { scale, stroke } of shapes) {
        const xs = points.map((p) => c.x + (p.x - c.x) * scale);
        const ys = points.map((p) => c.y + (p.y - c.y) * scale);
        const reach = radius * scale;
        const top = (g.tilt === 0 ? Math.min(...ys) : c.y - reach) + geometry.MASK_ORIGIN.y - stroke / 2;
        const bottom = (g.tilt === 0 ? Math.max(...ys) : c.y + reach) + geometry.MASK_ORIGIN.y + stroke / 2;
        const left = (g.tilt === 0 ? Math.min(...xs) : c.x - reach) + geometry.MASK_ORIGIN.x - stroke / 2;
        const right = (g.tilt === 0 ? Math.max(...xs) : c.x + reach) + geometry.MASK_ORIGIN.x + stroke / 2;
        const label = `${face} (scale ${scale}, stroke ${stroke})`;
        expect(top, `${label} is clipped at the top`).toBeGreaterThanOrEqual(box.y);
        expect(bottom, `${label} is clipped at the bottom`).toBeLessThanOrEqual(box.y + box.height);
        expect(left, `${label} is clipped on the left`).toBeGreaterThanOrEqual(box.x);
        expect(right, `${label} is clipped on the right`).toBeLessThanOrEqual(box.x + box.width);
      }
    }
    expect(render(skin, SCENARIOS.reclame()).getAttribute("viewBox")).toBe(`${box.x} ${box.y} ${box.width} ${box.height}`);
  });

  test("Seul is an empty stage with shut eyes, Endormi a dim stage with half-closed eyes", () => {
    const seul = render(skin, SCENARIOS.seul());
    expect(markers(seul)).toEqual([]);
    expect(seul.querySelector(".avatar-stage")?.getAttribute("data-empty")).toBe("true");
    const seulEyes = [...seul.querySelectorAll(".avatar-ink .avatar-opening")].slice(0, 2).map((el) => el.getAttribute("d"));
    expect(seulEyes).toEqual([...geometry.FACE_GEOMETRY.seul.eyes]);

    const endormi = render(skin, SCENARIOS.endormi());
    expect(markers(endormi).length).toBe(1);
    expect(endormi.querySelector(".avatar-stage")?.getAttribute("data-empty")).toBe("false");
    const endormiEyes = [...endormi.querySelectorAll(".avatar-ink .avatar-opening")].slice(0, 2).map((el) => el.getAttribute("d"));
    expect(endormiEyes).toEqual([...geometry.FACE_GEOMETRY.endormi.eyes]);
    expect(endormiEyes).not.toEqual(seulEyes);
  });

  function markerSpans(svg: SVGSVGElement): [number, number][] {
    const spans: [number, number][] = [];
    for (const el of svg.querySelectorAll("rect.avatar-pill")) {
      const x = Number(el.getAttribute("x"));
      spans.push([x, x + Number(el.getAttribute("width"))]);
    }
    for (const el of svg.querySelectorAll(".avatar-pill-glyph > g:not(.avatar-glyph-under)")) {
      const match = /translate\(([-\d.]+) [-\d.]+\) scale\(([\d.]+)\)/.exec(el.getAttribute("transform") ?? "");
      if (!match) throw new Error("a glyph marker has no translate/scale transform");
      spans.push([Number(match[1]), Number(match[1]) + 24 * Number(match[2])]);
    }
    const label = svg.querySelector(".avatar-stage-overflow");
    if (label) {
      const x = Number(label.getAttribute("x"));
      spans.push([x - geometry.STAGE_MARKER.min / 2, x + geometry.STAGE_MARKER.min / 2]);
    }
    return spans.sort((a, b) => a[0] - b[0]);
  }

  for (const [label, kinds] of [
    ["capsules", [{ idle: 1 }, { working: 1 }]],
    ["fault/lost/quota glyphs", [{ exited: 1 }, { rateLimited: 1 }]]
  ] as const) {
    test(`up to the stage capacity, ${label} never overlap`, () => {
      for (let count = 1; count <= geometry.STAGE_MARKER.capacity; count++) {
        const spans = markerSpans(render(skin, decks(count, [...kinds])));
        expect(spans.length).toBe(count);
        for (let i = 1; i < spans.length; i++) expect(spans[i]![0], `${count} decks: markers ${i - 1} and ${i} overlap`).toBeGreaterThanOrEqual(spans[i - 1]![1]);
      }
    });
  }

  test("twelve fault decks keep one torch each, shrunk to fit", () => {
    const allFault = produced((s, clock) => {
      for (let i = 0; i < 12; i++) s.receiveSnapshot({ identity: { deckRunId: `run-${i}`, broker_url: BROKER }, counters: counters({ working: 1 }), unread: 0 });
      clock.now += 20_000;
    });
    const svg = render(skin, allFault);
    expect(markers(svg).every((m) => m.kind === "fault")).toBe(true);
    const spans = markerSpans(svg);
    expect(spans.length).toBe(12);
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1]);
  });

  test("past the capacity the last slot counts the rest, without overlapping", () => {
    const svg = render(skin, decks(geometry.STAGE_MARKER.capacity + 5, [{ exited: 1 }, { rateLimited: 1 }]));
    expect(markers(svg).length).toBe(geometry.STAGE_MARKER.capacity - 1);
    expect(overflow(svg)).toBe(6);
    expect(svg.querySelector(".avatar-stage-overflow")?.textContent).toBe("+6");
    const spans = markerSpans(svg);
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1]);
  });
});

describe("stylesheet", () => {
  test("every rule of the avatar block is rooted under .avatar-root, keyframes and the named document rule aside", () => {
    const rules = cssRules(avatarCssBlock());
    expect(rules.filter((rule) => rule.atRule === null).length, "the avatar block parsed to almost nothing").toBeGreaterThan(20);
    expect(unrootedSelectors(rules), "these selectors leak into every renderer sharing styles.css").toEqual([]);
    expect(rules.filter((rule) => rule.atRule !== null && !rule.atRule.startsWith("@keyframes ")).map((rule) => rule.atRule)).toEqual([]);
    expect(rules.flatMap((rule) => rule.selectors), "the transparent-document rule is gone").toEqual(expect.arrayContaining([...AVATAR_DOCUMENT_SELECTORS]));
  });

  test("every --avatar-* the block consumes has a default on .avatar-root: the dark palette, and a loop under the repaint cap", () => {
    const block = avatarCssBlock();
    const consumed = [...new Set(Array.from(block.matchAll(/var\(\s*(--avatar-[\w-]+)/g), (m) => m[1]!))];
    expect(consumed.length, "the avatar block consumes no --avatar-* property, so this check sees nothing").toBeGreaterThan(10);
    const rules = cssRules(block);
    const defaults = Object.fromEntries(consumed.map((name) => [name, declarationValues(rules, ".avatar-root", name)[0]]));
    expect(consumed.filter((name) => defaults[name] === undefined), "consumed but never declared on .avatar-root").toEqual([]);
    for (const [key, hex] of Object.entries(geometry.AVATAR_PALETTE.dark)) {
      const name = `--avatar-${key}`;
      if (consumed.includes(name)) expect(defaults[name], `${name} default drifted from the dark palette`).toBe(hex);
    }
    const loopMs = Number.parseFloat(defaults["--avatar-loop-ms"] ?? "");
    const loopSteps = Number(defaults["--avatar-loop-steps"]);
    expect(loopSteps / (loopMs / 1000), "the default loop repaints faster than the cap").toBeLessThanOrEqual(4);
  });

  test("the rooting check catches a selector that does not start at .avatar-root", () => {
    const rules = cssRules(".avatar-root .a, .avatar-skin .b { fill: none } .avatar-rootish .c {} html.avatar-document .d, body { x: 1 } @keyframes k { from { opacity: 0 } }");
    expect(unrootedSelectors(rules)).toEqual([".avatar-skin .b", ".avatar-rootish .c", "html.avatar-document .d", "body"]);
  });

  test("with the real stylesheet, the avatar document has a transparent body and the Deck keeps its own", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(STYLES, "utf-8");
    document.head.appendChild(style);
    const html = document.documentElement;
    html.setAttribute("data-theme", "dark");
    try {
      const deckBody = getComputedStyle(document.body).backgroundColor;
      expect(deckBody, "the Deck body lost its background, so this check no longer sees the cascade").not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
      html.classList.add("avatar-document");
      expect(getComputedStyle(document.body).backgroundColor, "the Deck body background still paints the avatar window").toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
      expect(getComputedStyle(html).backgroundColor).toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
    } finally {
      html.classList.remove("avatar-document");
      html.removeAttribute("data-theme");
      style.remove();
    }
  });
});

describe("purity", () => {
  const BANNED = ["Date", "performance", "window", "document", "localStorage", "navigator", "globalThis", "crypto", "process", "fetch", "location"];
  const BANNED_RE = new RegExp(`(?<![.\\w$])(?:${BANNED.join("|")})(?![\\w$])|\\bMath\\.random\\b`, "g");

  function impure(source: string): string[] {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const found: string[] = [];
    for (const match of code.matchAll(BANNED_RE)) {
      const before = code.slice(0, match.index).trimEnd().at(-1);
      const objectKey = /^\s*:/.test(code.slice(match.index! + match[0].length)) && (before === undefined || before === "{" || before === ",");
      if (!objectKey) found.push(match[0]);
    }
    return found;
  }

  function resolveImport(from: string, specifier: string): string | null {
    const base = specifier.startsWith("@shared/") ? join(DESKTOP_SRC, "shared", specifier.slice("@shared/".length)) : specifier.startsWith(".") ? join(dirname(from), specifier) : null;
    if (base === null) return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    throw new Error(`${from} imports ${specifier}, which resolves to no file, so the purity closure would shrink`);
  }

  /** Runtime import closure of the skin registry: type-only imports are erased and not followed. */
  function skinModules(): string[] {
    const seen = new Set<string>();
    const queue = [SKIN_REGISTRY];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf-8");
      for (const match of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
        if (match[1]) continue;
        const target = resolveImport(file, match[2] ?? match[3]!);
        if (target !== null) queue.push(target);
      }
    }
    return [...seen].map((file) => relative(DESKTOP_SRC, file).split(sep).join("/")).sort();
  }

  test("the skin registry's import closure reads no clock, randomness, DOM, storage, network or process", () => {
    const modules = skinModules();
    expect(modules, "the closure lost a module the skin renders with").toEqual(
      expect.arrayContaining(["renderer/src/avatar/skins.ts", "renderer/src/avatar/MaskSkin.tsx", "shared/avatar-mask-geometry.ts", "renderer/src/components/icons.tsx"])
    );
    for (const file of modules) {
      expect(impure(readFileSync(join(DESKTOP_SRC, file), "utf-8")), `${file} reaches outside the summary it is given`).toEqual([]);
    }
  });

  test("the purity scan catches a known-bad source, a ternary included, and skips object keys and comments", () => {
    const bad = "const t = Date.now() + Math.random(); crypto.randomUUID(); fetch(location.href); process.env.X\nconst w = ok ? window : null";
    expect(impure(bad)).toEqual(["Date", "Math.random", "crypto", "fetch", "location", "process", "window"]);
    expect(impure("const glyphs = { window: Icon, document: Icon }\n// the window on the world\nconst a = s.performance")).toEqual([]);
  });
});

describe("palette", () => {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  };
  const ratio = (a: string, b: string) => {
    const x = lum(a);
    const y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  for (const [theme, palette] of Object.entries(geometry.AVATAR_PALETTE)) {
    test(`${theme}: every colour clears 3:1 on the underlay ring`, () => {
      for (const [name, colour] of Object.entries(palette)) {
        if (name === "underlay") continue;
        expect(ratio(colour, palette.underlay), `${theme} ${name} ${colour} on ${palette.underlay}`).toBeGreaterThanOrEqual(3);
      }
    });

    test(`${theme}: ink or underlay clears 3:1 on a white and on a black desktop`, () => {
      for (const desktop of ["#ffffff", "#000000"]) {
        const best = Math.max(ratio(palette.ink, desktop), ratio(palette.underlay, desktop));
        expect(best, `${theme} stroke unreadable on ${desktop}`).toBeGreaterThanOrEqual(3);
      }
    });

    test(`${theme}: Seul is more faded than Endormi`, () => {
      expect(ratio(palette.faded, palette.underlay)).toBeLessThan(ratio(palette.dim, palette.underlay));
    });

    test(`${theme}: the container receives one CSS variable per palette entry`, () => {
      const vars = avatarThemeVars(theme as "dark" | "light");
      expect(Object.values(vars).sort()).toEqual(Object.values(palette).sort());
      expect(Object.keys(vars).every((name) => name.startsWith("--avatar-"))).toBe(true);
    });
  }
});
