import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Root } from "../desktop/tests-support/react-test-harness"; // type-only: erased before bun resolves it
import { mockStore, storeMockStubs } from "./_store-mock";

const { act, React, createRoot, create } = await import("../desktop/tests-support/react-test-harness");

interface FakeDeckState {
  remote: boolean;
  sandboxStatus: { enabled: boolean } | null;
  dict: Record<string, string>;
  showToast: (key: string, kind: string) => void;
}

const toasts: [string, string][] = [];
const apiCalls: { openLink: unknown[][]; reportError: unknown[][] } = { openLink: [], reportError: [] };
let openOutcome: () => Promise<unknown> = async () => ({ ok: true });

function initialFakeState(): FakeDeckState {
  return {
    remote: false,
    sandboxStatus: { enabled: false },
    dict: {},
    showToast: (key, kind) => void toasts.push([key, kind])
  };
}

const fakeUseDeck = create<FakeDeckState>(() => initialFakeState());
mockStore({ useDeck: fakeUseDeck, ...storeMockStubs } as never);

const { LinkedText, segmentLinkedText } = await import("../desktop/src/renderer/src/components/LinkedText.tsx");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  toasts.length = 0;
  apiCalls.openLink.length = 0;
  apiCalls.reportError.length = 0;
  openOutcome = async () => ({ ok: true });
  (window as unknown as { api: unknown }).api = {
    openLink: async (...args: unknown[]) => {
      apiCalls.openLink.push(args);
      return openOutcome();
    },
    reportError: (...args: unknown[]) => void apiCalls.reportError.push(args)
  };
  fakeUseDeck.setState(initialFakeState(), true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(text: string): void {
  act(() => {
    root.render(React.createElement(LinkedText, { text }) as Parameters<Root["render"]>[0]);
  });
}

async function click(el: Element, init: MouseEventInit = {}): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, ...init }));
  });
}

async function pressKey(el: Element, key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, ...init }));
  });
}

const links = (): HTMLElement[] => [...container.querySelectorAll("span.text-link")] as HTMLElement[];
const linkTexts = (): string[] => links().map((l) => l.textContent ?? "");

describe("segmentLinkedText", () => {
  test("links and the text around them rejoin to the original, with the trailing dot and the :line suffix kept out of the target", () => {
    const text = "See https://example.com/a. Then C:\\work\\a.png:12 and /srv/x/y.md, done";
    const segments = segmentLinkedText(text);
    expect(segments.map((s) => s.text).join("")).toBe(text);
    expect(segments.filter((s) => s.kind === "link")).toEqual([
      { kind: "link", text: "https://example.com/a", target: "https://example.com/a" },
      { kind: "link", text: "C:\\work\\a.png:12", target: "C:\\work\\a.png" },
      { kind: "link", text: "/srv/x/y.md", target: "/srv/x/y.md" }
    ]);
  });

  test("text without a link is one text segment, an empty text has none, and a link at either end leaves no empty text segment", () => {
    expect(segmentLinkedText("nothing to click /help")).toEqual([{ kind: "text", text: "nothing to click /help" }]);
    expect(segmentLinkedText("")).toEqual([]);
    const ends = segmentLinkedText("https://a.example/x");
    expect(ends).toEqual([{ kind: "link", text: "https://a.example/x", target: "https://a.example/x" }]);
  });

  const linkTargets = (text: string): string[] =>
    segmentLinkedText(text).flatMap((s) => (s.kind === "link" ? [s.target] : []));

  test.each([
    ["userinfo with a password", "https://user:pass@example.com/x"],
    ["a trusted-looking name before the @", "https://trusted.com@evil.example/x"],
    ["a backslash that browsers read as the end of the host", "https://evil.example\\@trusted.com/x"],
    ["a Cyrillic letter in the host", `https://ex${String.fromCodePoint(0x430)}mple.com/x`],
    ["a right-to-left override in the path", `https://example.com/${String.fromCodePoint(0x202e)}fdp.exe`],
    ["a zero-width space in a file path", `C:\\work\\a${String.fromCodePoint(0x200b)}b.png`]
  ])("a decoy stays text, not a link: %s", (_label, decoy) => {
    const text = `see ${decoy} and https://ok.example/y`;
    expect(linkTargets(text)).toEqual(["https://ok.example/y"]);
    expect(segmentLinkedText(text).map((s) => s.text).join("")).toBe(text);
  });

  test("a legitimate look-alike stays a link: an @ after the first slash, an accented path", () => {
    expect(linkTargets("https://example.com/user@host?a=b@c")).toEqual(["https://example.com/user@host?a=b@c"]);
    expect(linkTargets("/srv/données/résumé.md")).toEqual(["/srv/données/résumé.md"]);
  });

  test("only the first 200 links of a text are links, the rest stays text and nothing is lost", () => {
    const urls = Array.from({ length: 201 }, (_, i) => `https://example.com/${i}`);
    const text = urls.join(" ");
    const segments = segmentLinkedText(text);
    expect(segments.filter((s) => s.kind === "link").length).toBe(200);
    expect(segments.map((s) => s.text).join("")).toBe(text);
    expect(linkTargets(urls.slice(0, 200).join(" ")).length, "exactly 200 links are all kept").toBe(200);
  });
});

describe("LinkedText on the Deck", () => {
  test("a link is a focusable span with role link inside the text, never a native control, and the rendered text is unchanged", () => {
    const text = "Open C:\\work\\overview.png now";
    render(text);
    expect(container.textContent).toBe(text);
    expect(linkTexts()).toEqual(["C:\\work\\overview.png"]);
    expect(links()[0]!.title).toBe("inbox.linkFileTitle");
    expect(links()[0]!.getAttribute("role")).toBe("link");
    expect(links()[0]!.getAttribute("tabindex")).toBe("0");
    expect(container.querySelectorAll("a, button").length, "a native control would block selecting the path").toBe(0);
  });

  test("click reveals, Ctrl+click and Cmd+click open, and the target carries no :line suffix", async () => {
    render("C:\\work\\a.png:12");
    const link = links()[0]!;
    await click(link);
    await click(link, { ctrlKey: true });
    await click(link, { metaKey: true });
    expect(apiCalls.openLink).toEqual([
      ["C:\\work\\a.png", "reveal"],
      ["C:\\work\\a.png", "open"],
      ["C:\\work\\a.png", "open"]
    ]);
  });

  test("Enter reveals and Ctrl+Enter opens, any other key does nothing", async () => {
    render("C:\\work\\a.png");
    const link = links()[0]!;
    await pressKey(link, "Enter");
    await pressKey(link, "Enter", { ctrlKey: true });
    await pressKey(link, " ");
    await pressKey(link, "a");
    expect(apiCalls.openLink).toEqual([
      ["C:\\work\\a.png", "reveal"],
      ["C:\\work\\a.png", "open"]
    ]);
  });

  test("a click that ends a text selection inside the link opens nothing, while a selection elsewhere or none does not block it", async () => {
    render("C:\\work\\a.png and other text");
    const link = links()[0]!;
    const selection = window.getSelection()!;

    selection.selectAllChildren(link);
    expect(selection.isCollapsed, "the selection must be non-empty for this case to mean anything").toBe(false);
    await click(link);
    expect(apiCalls.openLink).toEqual([]);

    selection.collapse(link.firstChild, 2);
    expect(selection.isCollapsed, "a caret inside the link is the state after a plain click").toBe(true);
    expect(link.contains(selection.anchorNode)).toBe(true);
    await click(link);
    expect(apiCalls.openLink).toEqual([["C:\\work\\a.png", "reveal"]]);

    const other = document.createElement("p");
    other.textContent = "elsewhere";
    document.body.appendChild(other);
    selection.selectAllChildren(other);
    await click(link);
    other.remove();
    selection.removeAllRanges();
    expect(apiCalls.openLink.length).toBe(2);
  });

  test("a middle or right button does nothing", async () => {
    render("https://example.com/x");
    await click(links()[0]!, { button: 1 });
    await click(links()[0]!, { button: 2 });
    expect(apiCalls.openLink).toEqual([]);
  });

  test("a web link is handed to openLink as a URL", async () => {
    render("go to https://example.com/page.");
    expect(links()[0]!.title).toBe("inbox.linkWebTitle");
    await click(links()[0]!);
    expect(apiCalls.openLink).toEqual([["https://example.com/page", "reveal"]]);
  });

  test("a refusal from main shows its toast and a rejected call is reported then shown as failed", async () => {
    render("C:\\work\\gone.png");
    openOutcome = async () => ({ ok: false, reason: "not-found" });
    await click(links()[0]!);
    expect(toasts).toEqual([["toast.linkNotFound", "error"]]);

    toasts.length = 0;
    openOutcome = async () => {
      throw new Error("ipc down");
    };
    await click(links()[0]!);
    expect(apiCalls.reportError).toEqual([["terminal", "open link failed: ipc down"]]);
    expect(toasts).toEqual([["toast.linkFailed", "error"]]);
  });

  test.each([
    ["a sandboxed project", { enabled: true }],
    ["a project whose sandbox status has not arrived", null]
  ])("on %s a path stays text while a web link is still a link", (_label, sandboxStatus) => {
    fakeUseDeck.setState({ sandboxStatus });
    render("C:\\work\\a.png and https://example.com/x");
    expect(linkTexts()).toEqual(["https://example.com/x"]);
    expect(container.textContent).toBe("C:\\work\\a.png and https://example.com/x");
  });

  test("markup in the text is rendered as text: no element, no handler", () => {
    const g = globalThis as Record<string, unknown>;
    delete g.__linkedPwned;
    const text = `<img src=x onerror="globalThis.__linkedPwned=1"> https://example.com/<b onmouseover="globalThis.__linkedPwned=2">`;
    render(text);
    expect(container.textContent).toBe(text);
    expect(container.querySelectorAll("img, b").length).toBe(0);
    expect(g.__linkedPwned).toBeUndefined();
  });
});

describe("LinkedText on a remote companion", () => {
  beforeEach(() => {
    fakeUseDeck.setState({ remote: true });
  });

  test("a web URL is a native anchor that opens in a new browsing context, a path stays text, and no button exists", () => {
    render("see https://example.com/a?b=1 and C:\\work\\a.png");
    const anchors = [...container.querySelectorAll("a")] as HTMLAnchorElement[];
    expect(anchors.map((a) => [a.getAttribute("href"), a.target, a.rel, a.textContent])).toEqual([
      ["https://example.com/a?b=1", "_blank", "noopener noreferrer", "https://example.com/a?b=1"]
    ]);
    expect(container.querySelectorAll("button").length, "openLink is blocked remotely, so no control may call it").toBe(0);
    expect(container.textContent).toBe("see https://example.com/a?b=1 and C:\\work\\a.png");
  });

  test("the anchor carries the normalised URL while the visible text stays as written", () => {
    render("HTTPS://EXAMPLE.COM/X");
    const anchor = container.querySelector("a") as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe("https://example.com/X");
    expect(anchor.textContent).toBe("HTTPS://EXAMPLE.COM/X");
  });

  test("a URL that does not parse is text, never an anchor", () => {
    render("broken https://[bad link");
    expect(container.querySelectorAll("a").length).toBe(0);
    expect(container.textContent).toBe("broken https://[bad link");
  });
});
