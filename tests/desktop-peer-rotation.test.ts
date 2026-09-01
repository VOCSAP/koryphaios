// Card 6f59c73a sub-lot L1: the peer_id rotation announce decision + wording
// (desktop/src/main/peer-rotation.ts), plus the wiring that consumes it.
//
// The decision probes cover the FOUR transitions, not the three the card
// names: disappearance, no-change, first resolution, rotation. "No change" is
// in because pollPeerIds runs on a TIMER -- a decision function that announced
// on every tick would flood the group, and no other probe would notice.
//
// The wording is probed here rather than scanned, for the reason written in
// the module's own header: a source scan is blind to message composition, and
// this repo has already shipped a regression of exactly that shape.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decidePeerAnnounce,
  composePeerRotationAnnounce,
  ROTATION_NO_REPLY_NOTE
} from "../desktop/src/main/peer-rotation.ts";

// ----- the decision: four transitions -----

test("first resolution WITH a join intent stays the existing join announce", () => {
  const d = decidePeerAnnounce({
    previousPeerId: null,
    nextPeerId: "koryphaios-7",
    tileName: "developer",
    hasJoinIntent: true
  });
  expect(d).toEqual({ kind: "join" });
});

test("first resolution WITHOUT a join intent stays silent (a resumed tile, already announced once)", () => {
  const d = decidePeerAnnounce({
    previousPeerId: null,
    nextPeerId: "koryphaios-7",
    tileName: "developer",
    hasJoinIntent: false
  });
  expect(d).toEqual({ kind: "silent", reason: "first-resolution-without-intent" });
});

test("a rotation announces, naming the tile and BOTH ids", () => {
  const d = decidePeerAnnounce({
    previousPeerId: "koryphaios-7",
    nextPeerId: "koryphaios-12",
    tileName: "developer",
    hasJoinIntent: false
  });
  expect(d.kind).toBe("rotation");
  const text = (d as { kind: "rotation"; text: string }).text;
  expect(text).toContain("developer");
  expect(text).toContain("koryphaios-12");
  // The OLD id must be named too: without it a reader cannot tell which of
  // their correspondents just went silent.
  expect(text).toContain("koryphaios-7");
});

test("a DISAPPEARANCE announces nothing -- an announce naming an empty id would be believed", () => {
  const d = decidePeerAnnounce({
    previousPeerId: "koryphaios-7",
    nextPeerId: null,
    tileName: "developer",
    hasJoinIntent: false
  });
  expect(d).toEqual({ kind: "silent", reason: "disappeared" });
});

test("a disappearance on a tile that never resolved is silent too, not a join", () => {
  const d = decidePeerAnnounce({
    previousPeerId: null,
    nextPeerId: null,
    tileName: "developer",
    hasJoinIntent: true // an intent is pending, and STILL nothing is announced
  });
  expect(d).toEqual({ kind: "silent", reason: "disappeared" });
});

// Review round 1: the disappearance guard tested `=== null`, so an EMPTY
// STRING id fell through to the rotation branch and produced, measured
// verbatim, `now answers to ""` -- exactly the announce naming an empty id
// that the 'disappeared' contract declares prescribed against. Unreachable
// from today's only caller, but this module is pure and exported, so its
// guarantee must hold across the values its own type admits. These two probes
// are what keep the correction from rotting back.

test("an EMPTY-STRING next id is a disappearance, never a rotation naming an empty id", () => {
  const d = decidePeerAnnounce({
    previousPeerId: "koryphaios-7",
    nextPeerId: "",
    tileName: "developer",
    hasJoinIntent: false
  });
  expect(d).toEqual({ kind: "silent", reason: "disappeared" });
});

test("an EMPTY-STRING previous id reads as a first resolution, never a rotation reporting (was \"\")", () => {
  const d = decidePeerAnnounce({
    previousPeerId: "",
    nextPeerId: "koryphaios-12",
    tileName: "developer",
    hasJoinIntent: true
  });
  expect(d).toEqual({ kind: "join" });
});

test("no change announces nothing (pollPeerIds runs on a timer -- this would flood)", () => {
  const d = decidePeerAnnounce({
    previousPeerId: "koryphaios-7",
    nextPeerId: "koryphaios-7",
    tileName: "developer",
    hasJoinIntent: false
  });
  expect(d).toEqual({ kind: "silent", reason: "unchanged" });
});

// ----- the wording -----

test("the rotation text carries the no-reply trailer, like the join announce does", () => {
  const text = composePeerRotationAnnounce("developer", "old-1", "new-2");
  expect(text).toContain(ROTATION_NO_REPLY_NOTE);
  // It must tell the reader what to DO (re-address), not merely that something
  // happened -- a notice nobody acts on is the current silence with extra
  // words.
  expect(ROTATION_NO_REPLY_NOTE).toContain("NEW peer_id");
});

test("an empty tile name degrades to a readable phrase, never to an empty quote", () => {
  const text = composePeerRotationAnnounce("   ", "old-1", "new-2");
  expect(text).toContain("a tile");
  expect(text).not.toContain('""');
});

// ----- the wiring (presence scan, deliberately the weak half) -----
//
// The probes above prove the decision and the wording. This proves the two
// production files actually route through them. It cannot prove the arguments
// are the right ones -- that is what the behavioural probes above are for.

test("session-service emits the previous id, and index.ts routes through the decision (real files)", () => {
  const main = join(import.meta.dir, "..", "desktop", "src", "main");
  const service = readFileSync(join(main, "session-service.ts"), "utf-8");
  const index = readFileSync(join(main, "index.ts"), "utf-8");

  // The emit must carry the PREVIOUS id -- without it the consumer cannot
  // tell a rotation from a first resolution at all.
  expect(service).toContain("previousPeerId: r.peerId");

  expect(index).toContain("import { decidePeerAnnounce } from './peer-rotation'");
  expect(index).toContain("decidePeerAnnounce(");
});

// Review round 1, and this is the assertion that carries the whole lot. The
// first version of it forbade only the LITERAL old condition
// (`if (next && r.peerId === null && r.announce)`), so ANY re-restriction
// written differently sailed through. Measured: `if (next && r.announce)`
// left this file at 11 pass / 0 fail while NEUTRALISING the entire feature --
// the join intent is consumed at the first emit (r.announce = null), so every
// later rotation finds it null, emits nothing, and the silence the lot exists
// to remove is back. Forbidding a TEXT is not forbidding a BEHAVIOUR.
//
// The comment-stripping is not cosmetic: the in-situ note deliberately quotes
// the old condition verbatim to explain what changed, so an absence scan over
// the raw slice matches its OWN documentation and is red on correct code.
test("pollPeerIds' emit fires on ANY transition to a live id, not a re-restricted subset", () => {
  const src = readFileSync(
    join(import.meta.dir, "..", "desktop", "src", "main", "session-service.ts"),
    "utf-8"
  );
  const start = src.indexOf("if (next !== r.peerId) {");
  expect(start).toBeGreaterThan(-1);
  const emitAt = src.indexOf("this.emit('peer-resolved'", start);
  expect(emitAt).toBeGreaterThan(start);
  const guard = src
    .slice(start, emitAt)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  // Neither of the two conditions that were deliberately dropped may come
  // back, in any spelling, anywhere between the change check and the emit.
  expect(guard).not.toContain("r.announce");
  expect(guard).not.toContain("r.peerId === null");
});
