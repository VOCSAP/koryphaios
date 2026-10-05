import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Root } from "../desktop/tests-support/react-test-harness";
import { AvatarState, type AvatarDeckCounters, type AvatarSummary } from "../desktop/src/shared/avatar-state.ts";
import * as geometry from "../desktop/src/shared/avatar-mask-geometry.ts";
import type { AvatarViewApi, AvatarViewPresentation, AvatarViewState } from "../desktop/src/shared/avatar-view.ts";

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const { act, React, createRoot } = await import("../desktop/tests-support/react-test-harness");

// bun does not resolve the tsconfig-only `@shared/*` alias from the repo root.
mock.module("@shared/avatar-mask-geometry", () => ({ ...geometry }));

const { AvatarApp } = await import("../desktop/src/renderer/src/avatar/AvatarApp");
const { AVATAR_FACES, avatarThemeVars } = await import("../desktop/src/renderer/src/avatar/skins");
const { MOTION_LIMITS } = await import("../desktop/src/renderer/src/avatar/motion");

const DECK = { deckRunId: "run-a", broker_url: "http://127.0.0.1:7899" };

function counters(partial: Partial<AvatarDeckCounters> = {}): AvatarDeckCounters {
  return { working: 0, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0, ...partial };
}

function summaryOf(partial: Partial<AvatarDeckCounters> | null): AvatarSummary {
  const state = new AvatarState({ now: () => 1_000_000 });
  if (partial !== null) state.receiveSnapshot({ identity: DECK, counters: counters(partial), unread: 0 });
  return state.summary();
}

const SUMMARIES = {
  seul: () => summaryOf(null),
  endormi: () => summaryOf({ idle: 1 }),
  travaille: () => summaryOf({ working: 1 }),
  travailleBusier: () => summaryOf({ working: 3 })
};

const PRESENTATION: AvatarViewPresentation = {
  position: null,
  theme: "dark",
  motion: "continuous",
  dndActive: false,
  visible: true,
  alwaysOnTop: true,
  positionLocked: false,
  size: "m",
  frame: "normal",
  idleOpacity: 1
};

function view(generation: number, revision: number, summary: AvatarSummary, presentation: Partial<AvatarViewPresentation> = {}): AvatarViewState {
  return { generation, revision, summary: { ...summary, faceCopy: { title: "t", ariaLabel: "a" } }, presentation: { ...PRESENTATION, ...presentation } };
}

interface FakeBridge {
  api: AvatarViewApi;
  calls: string[];
  errors: string[];
  push(state: AvatarViewState): void;
  reply(state: AvatarViewState): Promise<void>;
  fail(error: Error): Promise<void>;
}

function bridge(): FakeBridge {
  const calls: string[] = [];
  const errors: string[] = [];
  let listener: ((state: AvatarViewState) => void) | null = null;
  let settle: { resolve(state: AvatarViewState): void; reject(error: Error): void } | null = null;
  const api: AvatarViewApi = {
    getState: () => {
      calls.push("getState");
      return new Promise((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
    onState: (callback) => {
      calls.push("onState");
      listener = callback;
      return () => {
        calls.push("unsubscribe");
        listener = null;
      };
    },
    setPosition: async () => {},
    setPointerInside: async () => {},
    gesture: async () => {},
    reportError: (message) => {
      errors.push(message);
    }
  };
  return {
    api,
    calls,
    errors,
    push(state) {
      if (!listener) throw new Error("the container is not subscribed to onState");
      const deliver = listener;
      act(() => deliver(state));
    },
    async reply(state) {
      if (!settle) throw new Error("the container never called getState");
      const pending = settle;
      await act(async () => pending.resolve(state));
    },
    async fail(error) {
      if (!settle) throw new Error("the container never called getState");
      const pending = settle;
      await act(async () => pending.reject(error));
    }
  };
}

interface FakeQuery extends MediaQueryList {
  flip(matches: boolean): void;
}

function reducedMotionQuery(initial: boolean): FakeQuery {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    matches: initial,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
    flip(matches: boolean) {
      query.matches = matches;
      act(() => {
        for (const listener of listeners) listener({ matches } as MediaQueryListEvent);
      });
    }
  };
  return query as unknown as FakeQuery;
}

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

function mount(fake: FakeBridge, query: MediaQueryList | null = null): void {
  act(() => root.render(React.createElement(AvatarApp, { api: fake.api, reducedMotion: query })));
}

function shell(): HTMLElement {
  const el = container.querySelector<HTMLElement>(".avatar-root");
  if (!el) throw new Error("the container rendered no .avatar-root");
  return el;
}

const attr = (name: string): string | null => shell().getAttribute(name);

describe("entry document", () => {
  test("avatar.html is the transparent avatar document and boots the container entry", () => {
    const renderer = join(import.meta.dir, "..", "desktop", "src", "renderer");
    const html = readFileSync(join(renderer, "avatar.html"), "utf-8");
    const htmlTag = html.match(/<html\b[^>]*>/)?.[0] ?? "";
    expect(htmlTag, "without this class the Deck body paints the avatar window opaque").toMatch(/\bclass="[^"]*\bavatar-document\b/);
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts).toEqual(["/src/avatar/main.tsx"]);
    expect(existsSync(join(renderer, "src", "avatar", "main.tsx")), "the entry the page loads is missing").toBe(true);
  });
});

describe("subscription", () => {
  test("subscribes before reading the snapshot, renders nothing until a state arrives, unsubscribes on unmount", () => {
    const fake = bridge();
    mount(fake);
    expect(fake.calls).toEqual(["onState", "getState"]);
    expect(container.querySelector(".avatar-root"), "rendered before any state").toBeNull();
    act(() => root.unmount());
    expect(fake.calls).toEqual(["onState", "getState", "unsubscribe"]);
    root = createRoot(container);
  });

  test("a getState reply older than a pushed state is not applied after it", async () => {
    const fake = bridge();
    mount(fake);
    fake.push(view(1, 5, SUMMARIES.travaille()));
    await fake.reply(view(1, 3, SUMMARIES.endormi()));
    expect(attr("data-face")).toBe("travaille");
  });

  test("snapshots are ordered by generation first, then revision", async () => {
    const fake = bridge();
    mount(fake);
    await fake.reply(view(2, 10, SUMMARIES.travaille()));
    fake.push(view(2, 9, SUMMARIES.endormi()));
    expect(attr("data-face"), "an older revision of the same generation was applied").toBe("travaille");
    fake.push(view(2, 10, SUMMARIES.seul()));
    expect(attr("data-face"), "a replayed revision was applied").toBe("travaille");
    fake.push(view(1, 99, SUMMARIES.seul()));
    expect(attr("data-face"), "an older generation was applied").toBe("travaille");
    fake.push(view(3, 1, SUMMARIES.endormi()));
    expect(attr("data-face"), "a newer generation with a lower revision was refused").toBe("endormi");
  });

  test("a failing getState is reported, not thrown, and renders nothing", async () => {
    const fake = bridge();
    mount(fake);
    await fake.fail(new Error("bridge gone"));
    expect(fake.errors).toEqual(["avatar getState failed: bridge gone"]);
    expect(container.querySelector(".avatar-root")).toBeNull();
  });
});

describe("previous face", () => {
  test("a face change animates; a heartbeat keeps the same element and transition", async () => {
    const fake = bridge();
    mount(fake);
    await fake.reply(view(1, 1, SUMMARIES.endormi()));
    expect(attr("data-transition"), "the first paint animated").toBe("none");
    fake.push(view(1, 2, SUMMARIES.travaille()));
    expect(attr("data-transition")).toBe("animate");
    const skin = container.querySelector("svg.avatar-skin");
    fake.push(view(1, 3, SUMMARIES.travailleBusier()));
    expect(attr("data-transition"), "a counter change cut the running enter animation").toBe("animate");
    expect(skin, "no skin rendered").not.toBeNull();
    expect(container.querySelector("svg.avatar-skin") === skin, "a heartbeat remounted the skin, replaying the enter").toBe(true);
    fake.push(view(1, 4, SUMMARIES.endormi()));
    expect(container.querySelector("svg.avatar-skin") === skin, "a face change kept the old element, so the enter cannot replay").toBe(false);
  });

  test("previous survives a hide then a show, including a face change while hidden", async () => {
    const fake = bridge();
    mount(fake);
    await fake.reply(view(1, 1, SUMMARIES.endormi()));
    fake.push(view(1, 2, SUMMARIES.endormi(), { visible: false }));
    expect(attr("data-transition")).toBe("none");
    expect(attr("data-loop")).toBe("off");
    fake.push(view(1, 3, SUMMARIES.endormi()));
    expect(attr("data-transition"), "showing again replayed the enter animation").toBe("none");
    expect(attr("data-loop")).toBe("on");
    fake.push(view(1, 4, SUMMARIES.travaille(), { visible: false }));
    fake.push(view(1, 5, SUMMARIES.travaille()));
    expect(attr("data-transition"), "a face applied while hidden replayed on show").toBe("none");
    expect(attr("data-face")).toBe("travaille");
  });

  test("leaving DND does not replay, and DND cuts the halo", async () => {
    const fake = bridge();
    mount(fake);
    await fake.reply(view(1, 1, SUMMARIES.travaille()));
    fake.push(view(1, 2, SUMMARIES.endormi(), { dndActive: true }));
    expect(attr("data-transition")).toBe("none");
    expect(attr("data-halo")).toBe("off");
    fake.push(view(1, 3, SUMMARIES.endormi()));
    expect(attr("data-transition"), "leaving DND replayed the enter animation").toBe("none");
  });
});

describe("shell attributes", () => {
  test("theme palette and motion custom properties sit on .avatar-root and follow the theme", async () => {
    const fake = bridge();
    mount(fake);
    await fake.reply(view(1, 1, SUMMARIES.travaille()));
    for (const [name, value] of Object.entries(avatarThemeVars("dark"))) {
      expect(shell().style.getPropertyValue(name), `${name} in dark`).toBe(value);
    }
    expect(shell().style.getPropertyValue("--avatar-loop-steps")).not.toBe("");
    expect(shell().style.getPropertyValue("--avatar-transition-ms")).toBe("0ms");
    fake.push(view(1, 2, SUMMARIES.travaille(), { theme: "light" }));
    for (const [name, value] of Object.entries(avatarThemeVars("light"))) {
      expect(shell().style.getPropertyValue(name), `${name} in light`).toBe(value);
    }
    expect(avatarThemeVars("light")["--avatar-ink"]).not.toBe(avatarThemeVars("dark")["--avatar-ink"]);
  });

  test("title and aria-label are the main's copy for each of the seven faces, and follow a newer view", async () => {
    const fake = bridge();
    mount(fake);
    const base = SUMMARIES.seul();
    const copyOf = (face: string, count: number) => ({ title: `title ${face} ${count}`, ariaLabel: `label ${face} ${count}` });
    await fake.reply({ ...view(1, 1, base), summary: { ...base, face: AVATAR_FACES[0]!, faceCopy: copyOf(AVATAR_FACES[0]!, 0) } });
    let revision = 1;
    for (const face of AVATAR_FACES) {
      for (const count of [1, 2]) {
        revision += 1;
        const faceCopy = copyOf(face, count);
        fake.push({ ...view(1, revision, base), summary: { ...base, face, faceCopy } });
        expect(attr("data-face")).toBe(face);
        expect(attr("title"), `${face} title`).toBe(faceCopy.title);
        expect(attr("aria-label"), `${face} aria-label`).toBe(faceCopy.ariaLabel);
      }
    }
    expect(attr("role"), "aria-label is not announced on a generic div").toBe("img");
    expect(shell().querySelector("svg.avatar-skin"), "the skin is not mounted").not.toBeNull();
  });

  test("the OS reduced-motion preference wins over continuous and follows its change event", async () => {
    const fake = bridge();
    const query = reducedMotionQuery(true);
    mount(fake, query);
    await fake.reply(view(1, 1, SUMMARIES.endormi()));
    expect(attr("data-loop"), "reduced motion still loops").toBe("off");
    fake.push(view(1, 2, SUMMARIES.travaille()));
    expect(attr("data-transition")).toBe("fade");
    expect(shell().style.getPropertyValue("--avatar-transition-ms")).toBe(`${MOTION_LIMITS.fadeMs}ms`);
    query.flip(false);
    expect(attr("data-loop"), "the change event was not followed").toBe("on");
    expect(attr("data-transition"), "a preference change replayed the enter").toBe("none");
  });
});
