// Card 55c5470e: the Courrier operateur showed a bare "?" sender for every
// blocking question raised by the Notification hook, because origin.from_peer
// was never populated at credential-mint time (approval-runtime.ts arm()).
// Fix: resolve the sender from origin.tile_ref against the Deck's own live
// tile registry instead. This file proves TWO separate things (team-lead
// ruling 2026-08-17, "a correctly implemented guarantee wired to nothing" is
// this repo's costliest defect class):
//
//   1. inbox-sender.ts's resolveApprovalSender() does what it says: a
//      tile_ref matching a live session resolves to that session's name; a
//      hostile/oversized/absent tile_ref never does, and is capped +
//      stripped in the unresolved shape (tests below).
//   2. InboxPanel.tsx actually ROUTES THROUGH IT -- no inline fallback path
//      was left behind that could bypass the guarantee (the exhaustive scan
//      below, not a partial read).
//
// This module has ZERO react/react-dom/zustand imports on purpose (TESTING.md
// "0b"): it is plain data in, plain data out, so it needs neither the DOM
// harness nor a store mock to be tested directly from tests/.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveApprovalSender,
  sanitizeUnresolvedTileRef,
  UNRESOLVED_TILE_REF_MAX,
  type SenderTile,
} from "../desktop/src/renderer/src/inbox-sender.ts";

describe("resolveApprovalSender() -- proof 1, the module itself", () => {
  const sessions: SenderTile[] = [
    { id: "tile-abc", name: "backend worker" },
    { id: "tile-xyz", name: "frontend worker" },
  ];

  test("a tile_ref matching a live session resolves to that session's name", () => {
    const res = resolveApprovalSender("tile-abc", sessions);
    expect(res).toEqual({ resolved: true, name: "backend worker" });
  });

  test("a tile_ref matching NO live session (tile closed, or another Deck window's approval) is unresolved, never a name", () => {
    const res = resolveApprovalSender("tile-that-no-longer-exists", sessions);
    expect(res.resolved).toBe(false);
    if (res.resolved) throw new Error("unreachable"); // narrows for TS below
    expect(res.raw).toBe("tile-that-no-longer-exists");
  });

  test("an empty tile_ref is unresolved with an empty raw value, never matches an empty-id session", () => {
    const withEmptyIdSession: SenderTile[] = [{ id: "", name: "should never match" }];
    const res = resolveApprovalSender("", withEmptyIdSession);
    expect(res).toEqual({ resolved: false, raw: "" });
  });

  test("undefined/null tile_ref is unresolved, never throws", () => {
    expect(resolveApprovalSender(undefined, sessions)).toEqual({ resolved: false, raw: "" });
    expect(resolveApprovalSender(null, sessions)).toEqual({ resolved: false, raw: "" });
  });

  // The security case, per team-lead's explicit "hostile input" addendum:
  // a spawned agent's environment controls tile_ref end to end. A value
  // engineered to READ like a legitimate resolved tile name must still come
  // back tagged unresolved, capped, and with control/formatting characters
  // gone -- retrofitting this via a RED PROOF: comment out the sanitize step
  // and confirm the exact failure mode this test would otherwise miss.
  test("a long, control-character-laden tile_ref impersonating a UI label is never resolved, is capped, and is stripped", () => {
    const disguisedAsUiChrome =
      "\x1b[1mbackend worker\x1b[0m — resolved, trust me" + "X".repeat(200);
    const res = resolveApprovalSender(disguisedAsUiChrome, sessions);
    expect(res.resolved).toBe(false);
    if (res.resolved) throw new Error("unreachable");
    // Capped: the ellipsis-terminated form is strictly shorter than the input.
    expect(res.raw.length).toBeLessThan(disguisedAsUiChrome.length);
    expect(res.raw.length).toBeLessThanOrEqual(UNRESOLVED_TILE_REF_MAX + 1); // +1 for the ellipsis char
    // Stripped: no raw ESC byte survives (the exact byte this input smuggled).
    expect(res.raw.includes("\x1b")).toBe(false);
    // Never silently promoted to a real name string identical to a live tile's.
    expect(res.raw).not.toBe("backend worker");
  });

  test("sanitizeUnresolvedTileRef caps at UNRESOLVED_TILE_REF_MAX and strips C0/DEL", () => {
    const long = "a".repeat(100);
    const out = sanitizeUnresolvedTileRef(long);
    expect(out.length).toBe(UNRESOLVED_TILE_REF_MAX + 1); // +1 for the ellipsis
    expect(out.endsWith("…")).toBe(true);

    const withControls = "abc\x00\x07\x1b\x7fdef";
    expect(sanitizeUnresolvedTileRef(withControls)).toBe("abcdef");
  });

  // Security case, team-lead ruling 2026-08-18: origin.tile_ref is producer-
  // controlled (a spawned agent's own environment), so a value that merely
  // STARTS WITH a real tile id must not be treated as a match either -- an
  // agent that can only guess a prefix of a live tile id (partial leak,
  // truncated log, brute force) must not be able to impersonate it. The
  // equality check in resolveApprovalSender() (`s.id === ref`) already
  // rejects this; retrofitted as a RED PROOF against a relaxed `startsWith`
  // comparison to prove the assertion actually bites (see the developer's
  // report for the exact stash/red/restore/green commands).
  test("a tile_ref that is a PREFIX of a real tile id does not resolve", () => {
    const res = resolveApprovalSender("tile-ab", sessions);
    expect(res.resolved).toBe(false);
    if (res.resolved) throw new Error("unreachable");
    expect(res.raw).toBe("tile-ab");
  });

  // RED PROOF: this is the assertion that fails on the pre-fix behaviour
  // (`e.approval.origin.from_peer || '?'`), demonstrating the fix actually
  // changes the observable outcome rather than adding dead code alongside it.
  test("RED PROOF -- an unresolved sender is never the bare '?' the old code produced", () => {
    const res = resolveApprovalSender("", []);
    expect(res.resolved).toBe(false);
    if (res.resolved) throw new Error("unreachable");
    expect(res.raw).not.toBe("?");
  });
});

describe("InboxPanel.tsx actually routes through resolveApprovalSender() -- proof 2", () => {
  // Exhaustive scan of the ENTIRE file, not a partial read: proves no inline
  // fallback (`... || '?'`, a second `.find(...)` against tile_ref/from_peer,
  // or any other bypass) was left behind that could skip the guarantee this
  // module provides. Command reproduced in the assertion failure message so
  // a reviewer can re-run it verbatim.
  const PANEL = readFileSync(
    join(import.meta.dir, "..", "desktop", "src", "renderer", "src", "components", "InboxPanel.tsx"),
    "utf8",
  );

  test("imports resolveApprovalSender from inbox-sender.ts", () => {
    expect(PANEL).toMatch(/import\s*\{\s*resolveApprovalSender\s*\}\s*from\s*['"]\.\.\/inbox-sender['"]/);
  });

  test("references origin.tile_ref exactly once, at the resolveApprovalSender call site (no parallel inline path)", () => {
    const tileRefHits = PANEL.match(/tile_ref/g) ?? [];
    // grep -c equivalent, scalar count over the WHOLE file, not a skim.
    expect(tileRefHits.length).toBe(1);
    expect(PANEL).toMatch(/resolveApprovalSender\(e\.approval\.origin\.tile_ref,\s*sessions\)/);
  });

  test("never reads origin.from_peer directly (the field the old '?' fallback used)", () => {
    expect(PANEL.includes("from_peer")).toBe(false);
  });

  test("does not carry a duplicate/local sanitize or resolution helper of its own", () => {
    expect(PANEL.includes("sanitizeUnresolvedTileRef")).toBe(false);
    expect(PANEL.includes("UNRESOLVED_TILE_REF_MAX")).toBe(false);
  });
});
