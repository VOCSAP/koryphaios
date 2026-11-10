import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COUNTER_LIMIT,
  FRAME_TYPE,
  MAX_PAYLOAD,
  Opener,
  PRE_AUTH_MAX_PAYLOAD,
  PlainFrameDecoder,
  ProtocolViolation,
  SEALED_FRAME_OVERHEAD,
  Sealer,
  SealedFrameDecoder,
  b64u,
  buildAuth,
  buildAuthOk,
  buildChallenge,
  deriveSessionKeys,
  encodeFrame,
  mintTicket,
  negotiateProto,
  parseHello,
  relayMac,
  validateHello,
  verifyAuth,
  verifyAuthOk,
  verifyTicket,
  type Challenge,
  type Hello,
  type HelloResult,
  type TicketClaims,
} from "../shared/mcp-daemon-protocol.ts";

const fx: any = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "relay", "protocol-fixtures", "frames.json"), "utf8"),
);
const hs = fx.handshake;
const key = Buffer.from(hs.key_hex, "hex");
const challenge: Challenge = {
  payload: Buffer.from(hs.challenge_payload),
  daemonNonce: hs.daemon_nonce,
  protoMin: 1,
  protoMax: 1,
};
const authPayload = Buffer.from(hs.auth_payload);
const authOkPayload = Buffer.from(hs.auth_ok_payload);
const nonce32 = (fill: number) => Buffer.alloc(32, fill);

function auth(relayNonce: string, protoMin = 1, protoMax = 1, mac?: string): Buffer {
  const signed = mac ?? b64u(relayMac(key, challenge, relayNonce, protoMin, protoMax));
  return Buffer.from(JSON.stringify({ mac: signed, proto_max: protoMax, proto_min: protoMin, relay_nonce: relayNonce }));
}

function accepted(result: HelloResult): Hello {
  if (!result.ok) throw new Error(`hello refused: ${result.cause}`);
  return result.hello;
}

function header(len: number): Buffer {
  const h = Buffer.alloc(4);
  h.writeUInt32LE(len);
  return h;
}

function violation(fn: () => unknown): ProtocolViolation {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolViolation);
    return e as ProtocolViolation;
  }
  throw new Error("expected a ProtocolViolation, nothing was thrown");
}

describe("plain frames", () => {
  test("type numbers and payload limit are the ones frozen in the fixture", () => {
    expect({ ...FRAME_TYPE }).toEqual(fx.frame.types);
    expect(MAX_PAYLOAD).toBe(fx.frame.max_payload_bytes);
  });

  test("encodes the fixture example: length counts the type byte, little-endian", () => {
    const ex = fx.frame.example;
    expect(encodeFrame(ex.type, Buffer.from(ex.payload)).toString("hex")).toBe(ex.bytes_hex);
  });

  test("refuses to encode a payload above the limit", () => {
    expect(violation(() => encodeFrame(FRAME_TYPE.MCP, Buffer.alloc(MAX_PAYLOAD + 1))).code).toBe("payload_too_large");
  });

  test("reassembles frames split byte by byte and frames glued in one chunk", () => {
    const a = encodeFrame(FRAME_TYPE.PING, Buffer.alloc(0));
    const b = encodeFrame(FRAME_TYPE.MCP, Buffer.from('{"a":1}'));
    const stream = Buffer.concat([a, b]);

    const bytewise = new PlainFrameDecoder();
    const got = [...stream].flatMap((byte) => bytewise.push(Buffer.from([byte])));
    expect(got.map((f) => [f.type, f.payload.toString()])).toEqual([
      [FRAME_TYPE.PING, ""],
      [FRAME_TYPE.MCP, '{"a":1}'],
    ]);

    const glued = new PlainFrameDecoder().push(stream);
    expect(glued.map((f) => f.type)).toEqual([FRAME_TYPE.PING, FRAME_TYPE.MCP]);
  });

  test("a zero length is a violation as soon as the header is read", () => {
    expect(violation(() => new PlainFrameDecoder().push(header(0))).code).toBe("frame_length");
  });

  test("the payload limit is exact: limit+1 bytes of length waits, one more is refused before any body", () => {
    const decoder = new PlainFrameDecoder();
    expect(decoder.push(header(PRE_AUTH_MAX_PAYLOAD + 1))).toEqual([]);
    expect(violation(() => new PlainFrameDecoder().push(header(PRE_AUTH_MAX_PAYLOAD + 2))).code).toBe("frame_length");
  });

  test("the limit follows the decoder's maxPayload, up to 16 MiB", () => {
    const wide = new PlainFrameDecoder(MAX_PAYLOAD);
    expect(wide.push(header(MAX_PAYLOAD + 1))).toEqual([]);
    expect(violation(() => new PlainFrameDecoder(MAX_PAYLOAD).push(header(MAX_PAYLOAD + 2))).code).toBe(
      "frame_length",
    );
  });
});

describe("handshake, daemon side", () => {
  test("builds the fixture CHALLENGE payload byte for byte", () => {
    const built = buildChallenge({
      daemonInstance: "fake",
      daemonVersion: "0",
      nonce: Buffer.from(hs.daemon_nonce, "base64url"),
    });
    expect(built.payload.toString()).toBe(hs.challenge_payload);
    expect(built.daemonNonce).toBe(hs.daemon_nonce);
  });

  test("a generated CHALLENGE nonce is 32 random bytes in unpadded base64url", () => {
    const a = buildChallenge({ daemonInstance: "i", daemonVersion: "v" });
    const b = buildChallenge({ daemonInstance: "i", daemonVersion: "v" });
    expect(Buffer.from(a.daemonNonce, "base64url")).toHaveLength(32);
    expect(a.daemonNonce).not.toContain("=");
    expect(a.daemonNonce).not.toBe(b.daemonNonce);
  });

  test("accepts the fixture AUTH and selects proto 1", () => {
    expect(verifyAuth(key, challenge, authPayload)).toEqual({ ok: true, proto: 1, relayNonce: hs.relay_nonce });
  });

  test("the relay MAC and the control-role MAC match the fixture, and differ", () => {
    const relay = b64u(relayMac(key, challenge, hs.relay_nonce, 1, 1));
    const control = b64u(relayMac(key, challenge, hs.relay_nonce, 1, 1, "control"));
    expect(relay).toBe(hs.relay_mac);
    expect(control).toBe(hs.control_mac_of_relay_message);
    expect(control).not.toBe(relay);
  });

  test("a MAC signed with the control role is never accepted as relay", () => {
    const refused = verifyAuth(key, challenge, auth(hs.relay_nonce, 1, 1, hs.control_mac_of_relay_message));
    expect(refused).toMatchObject({ ok: false, reason: "bad_mac" });
  });

  test("builds the fixture AUTH_OK payload: its MAC covers the whole AUTH payload", () => {
    expect(buildAuthOk(key, challenge, authPayload, hs.relay_nonce, 1).toString()).toBe(hs.auth_ok_payload);
    const other = Buffer.from(hs.auth_payload.replace(/\}$/, ',"extra":1}'));
    expect(buildAuthOk(key, challenge, other, hs.relay_nonce, 1).toString()).not.toBe(hs.auth_ok_payload);
  });

  test.each([
    ["31 bytes", b64u(nonce32(7).subarray(0, 31))],
    ["33 bytes", b64u(Buffer.concat([nonce32(7), Buffer.from([1])]))],
    ["32 bytes with base64 padding", `${b64u(nonce32(7))}=`],
    ["32 bytes with a foreign character", `${b64u(nonce32(7)).slice(0, 42)}*`],
    ["empty", ""],
    ["32 bytes with non-zero trailing bits", `${"A".repeat(42)}B`],
  ])("refuses a relay_nonce of %s even when its MAC is valid", (_label, relayNonce) => {
    expect(verifyAuth(key, challenge, auth(relayNonce))).toMatchObject({ ok: false, reason: "malformed" });
  });

  test("refuses a relay_nonce that is not a string", () => {
    const body = JSON.stringify({ mac: hs.relay_mac, proto_max: 1, proto_min: 1, relay_nonce: 12345 });
    expect(verifyAuth(key, challenge, Buffer.from(body))).toMatchObject({ ok: false, reason: "malformed" });
  });

  test.each([
    ["31 bytes", b64u(Buffer.alloc(31, 9))],
    ["33 bytes", b64u(Buffer.alloc(33, 9))],
    ["32 bytes with padding", `${b64u(Buffer.alloc(32, 9))}=`],
    ["a truncated valid MAC", hs.relay_mac.slice(0, 40)],
    ["32 bytes with non-zero trailing bits", `${"A".repeat(42)}B`],
  ])("refuses a MAC of %s without comparing it", (_label, mac) => {
    expect(verifyAuth(key, challenge, auth(hs.relay_nonce, 1, 1, mac))).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  test("refuses AUTH that is not JSON, not an object, or has a bad version range", () => {
    expect(verifyAuth(key, challenge, Buffer.from("nope"))).toMatchObject({ ok: false, reason: "malformed" });
    expect(verifyAuth(key, challenge, Buffer.from("[]"))).toMatchObject({ ok: false, reason: "malformed" });
    for (const [lo, hi] of [
      [2, 1],
      [0, 1],
      [1.5, 2],
    ] as const) {
      expect(verifyAuth(key, challenge, auth(hs.relay_nonce, lo, hi))).toMatchObject({
        ok: false,
        reason: "malformed",
      });
    }
  });

  test("a proxy that changes the CHALLENGE payload makes the MAC fail", () => {
    const altered = { ...challenge, payload: Buffer.from(hs.challenge_payload.replace('"fake"', '"evil"')) };
    expect(verifyAuth(key, altered, authPayload)).toMatchObject({ ok: false, reason: "bad_mac" });
  });

  test("a proxy that widens the offered version range makes the MAC fail", () => {
    const body = JSON.parse(hs.auth_payload);
    body.proto_max = 2;
    expect(verifyAuth(key, challenge, Buffer.from(JSON.stringify(body)))).toMatchObject({
      ok: false,
      reason: "bad_mac",
    });
  });

  test("a MAC computed with another key fails", () => {
    expect(verifyAuth(Buffer.alloc(32, 1), challenge, authPayload)).toMatchObject({ ok: false, reason: "bad_mac" });
  });

  test("a MAC bound to another daemon nonce fails", () => {
    const other = { ...challenge, daemonNonce: b64u(nonce32(3)) };
    expect(verifyAuth(key, other, authPayload)).toMatchObject({ ok: false, reason: "bad_mac" });
  });
});

describe("version negotiation", () => {
  test.each([
    [1, 1, 1, 1, 1],
    [1, 3, 2, 5, 3],
    [1, 3, 1, 2, 2],
    [2, 4, 1, 3, 3],
    [1, 1, 2, 2, null],
    [3, 4, 1, 2, null],
  ])("daemon %i..%i with relay %i..%i selects %p", (aMin, aMax, bMin, bMax, expected) => {
    expect(negotiateProto(aMin, aMax, bMin, bMax)).toBe(expected);
  });

  test("a relay with no common version gets proto_mismatch once its MAC is valid", () => {
    expect(verifyAuth(key, challenge, auth(hs.relay_nonce, 2, 2))).toMatchObject({
      ok: false,
      reason: "proto_mismatch",
    });
  });

  test("a bad MAC wins over a version mismatch: an unauthenticated peer learns nothing about versions", () => {
    const forged = auth(hs.relay_nonce, 2, 2, hs.relay_mac);
    expect(verifyAuth(key, challenge, forged)).toMatchObject({ ok: false, reason: "bad_mac" });
  });

  test("a daemon offering 1..3 selects the highest version the relay offers", () => {
    const wide: Challenge = { ...challenge, protoMax: 3 };
    const nonce = hs.relay_nonce;
    const body = Buffer.from(
      JSON.stringify({
        mac: b64u(relayMac(key, wide, nonce, 1, 2)),
        proto_max: 2,
        proto_min: 1,
        relay_nonce: nonce,
      }),
    );
    expect(verifyAuth(key, wide, body)).toEqual({ ok: true, proto: 2, relayNonce: nonce });
  });
});

describe("session keys and sealed frames", () => {
  const keys = deriveSessionKeys(key, challenge, authPayload, authOkPayload, hs.relay_nonce);
  const frames = (direction: string) =>
    fx.sealed.frames
      .filter((f: { direction: string }) => f.direction === direction)
      .map((f: { type: number; payload: string; wire_hex: string }) => ({
        type: f.type,
        payload: Buffer.from(f.payload),
        wire: Buffer.from(f.wire_hex, "hex"),
      }));

  test("derives the fixture keys, one per direction", () => {
    expect(keys.r2d.toString("hex")).toBe(fx.sealed.k_r2d_hex);
    expect(keys.d2r.toString("hex")).toBe(fx.sealed.k_d2r_hex);
    expect(keys.r2d.equals(keys.d2r)).toBe(false);
  });

  test("the keys are bound to the AUTH_OK payload of the connection", () => {
    const other = Buffer.from(hs.auth_ok_payload.replace("zuAU", "zuAV"));
    expect(deriveSessionKeys(key, challenge, authPayload, other, hs.relay_nonce).r2d.equals(keys.r2d)).toBe(false);
  });

  test.each([0, 1, 4096])("a sealed frame is its payload plus SEALED_FRAME_OVERHEAD bytes (payload of %d)", (size) => {
    const wire = new Sealer(keys.d2r).seal(FRAME_TYPE.MCP, Buffer.alloc(size, 7));
    expect(wire.length).toBe(size + SEALED_FRAME_OVERHEAD);
  });

  test("seals the relay-to-daemon fixture frames at counters 0 and 1", () => {
    const sealer = new Sealer(keys.r2d);
    for (const f of frames("r2d")) expect(sealer.seal(f.type, f.payload).toString("hex")).toBe(f.wire.toString("hex"));
  });

  test("seals the daemon-to-relay fixture frames at counters 0 and 1", () => {
    const sealer = new Sealer(keys.d2r);
    for (const f of frames("d2r")) expect(sealer.seal(f.type, f.payload).toString("hex")).toBe(f.wire.toString("hex"));
  });

  test("opens the relay-to-daemon fixture frames in order", () => {
    const opener = new Opener(keys.r2d);
    for (const f of frames("r2d")) {
      const opened = opener.open(f.wire);
      expect(opened.type).toBe(f.type);
      expect(opened.payload.equals(f.payload)).toBe(true);
    }
  });

  test("a frame of one direction does not open under the other direction's key", () => {
    const [first] = frames("d2r");
    expect(violation(() => new Opener(keys.r2d).open(first.wire)).code).toBe("seal_auth");
  });

  test("a frame opened out of order is refused: the counter is part of the nonce", () => {
    const [, second] = frames("r2d");
    expect(violation(() => new Opener(keys.r2d).open(second.wire)).code).toBe("seal_auth");
  });

  test("a replayed frame is refused the second time", () => {
    const [first] = frames("r2d");
    const opener = new Opener(keys.r2d);
    opener.open(first.wire);
    expect(violation(() => opener.open(first.wire)).code).toBe("seal_auth");
  });

  test.each([
    ["a ciphertext byte", 6],
    ["the last tag byte", -1],
  ])("an invalid tag is fatal: flipping %s", (_label, at) => {
    const [first] = frames("r2d");
    const wire = Buffer.from(first.wire);
    const index = at < 0 ? wire.length + at : at;
    wire[index] = (wire[index] as number) ^ 1;
    expect(violation(() => new Opener(keys.r2d).open(wire)).code).toBe("seal_auth");
  });

  test("a sealed frame whose header disagrees with its size is refused", () => {
    const [first] = frames("r2d");
    const wire = Buffer.concat([first.wire, Buffer.from([0])]);
    expect(violation(() => new Opener(keys.r2d).open(wire)).code).toBe("frame_length");
  });

  test("seals and opens a payload of one megabyte", () => {
    const big = Buffer.alloc(1_000_000, 0x61);
    const wire = new Sealer(keys.d2r).seal(FRAME_TYPE.MCP, big);
    const opened = new Opener(keys.d2r).open(wire);
    expect(opened.payload.equals(big)).toBe(true);
  });

  test("refuses to seal a payload above 16 MiB", () => {
    expect(violation(() => new Sealer(keys.r2d).seal(FRAME_TYPE.MCP, Buffer.alloc(MAX_PAYLOAD + 1))).code).toBe(
      "payload_too_large",
    );
  });

  test("the last counter below 2^48 still seals and opens, the next one is refused", () => {
    const last = COUNTER_LIMIT - 1n;
    const sealer = new Sealer(keys.r2d, last);
    const wire = sealer.seal(FRAME_TYPE.PING, Buffer.alloc(0));
    expect(new Opener(keys.r2d, last).open(wire).type).toBe(FRAME_TYPE.PING);
    expect(violation(() => sealer.seal(FRAME_TYPE.PING, Buffer.alloc(0))).code).toBe("counter_exhausted");
    expect(violation(() => new Opener(keys.r2d, COUNTER_LIMIT).open(wire)).code).toBe("counter_exhausted");
  });

  test("the sealed decoder reassembles split chunks and opens each frame in sequence", () => {
    const decoder = new SealedFrameDecoder(new Opener(keys.r2d));
    const stream = Buffer.concat(frames("r2d").map((f: { wire: Buffer }) => f.wire));
    const got = [];
    for (let i = 0; i < stream.length; i += 7) got.push(...decoder.push(stream.subarray(i, i + 7)));
    expect(got.map((f) => f.type)).toEqual([FRAME_TYPE.HELLO, FRAME_TYPE.MCP]);
  });

  test("the sealed decoder refuses a length under 17 and a length above its limit before any body", () => {
    const opener = () => new SealedFrameDecoder(new Opener(keys.r2d), 100);
    expect(violation(() => opener().push(header(16))).code).toBe("frame_length");
    expect(opener().push(header(17))).toEqual([]);
    expect(opener().push(header(117))).toEqual([]);
    expect(violation(() => opener().push(header(118))).code).toBe("frame_length");
  });
});

describe("HELLO validation", () => {
  const code_root = "a".repeat(64);
  const hello = (over: Record<string, unknown> = {}) => ({
    proto: 1,
    family: "peers",
    relay_version: "0.1.0",
    code_root,
    pid: 4242,
    ppid: 100,
    pid_start: "133750000000000000",
    ppid_start: "",
    cwd: "C:\\Users\\user\\workspace",
    stdin_is_tty: false,
    env: { PATH: "x" },
    replay: false,
    ...over,
  });
  const manyVars = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`V${i}`, "x"]));

  test("accepts a complete hello, with or without resume_ticket, for both families", () => {
    expect(validateHello(hello(), 1)).toMatchObject({ ok: true });
    expect(validateHello(hello({ family: "roadmap", resume_ticket: "t" }), 1)).toMatchObject({ ok: true });
  });

  test.each(["/home/user/work", "C:\\Users\\x", "C:/Users/x", "\\\\server\\share\\x"])(
    "accepts the absolute cwd %s",
    (cwd) => {
      expect(validateHello(hello({ cwd }), 1)).toMatchObject({ ok: true });
    },
  );

  test.each([
    ["proto differing from the negotiated one", { proto: 2 }, "proto"],
    ["family outside peers|roadmap", { family: "admin" }, "family"],
    ["missing family", { family: undefined }, "family"],
    ["relative cwd", { cwd: "work/dir" }, "cwd"],
    ["drive-relative cwd", { cwd: "C:work" }, "cwd"],
    ["empty cwd", { cwd: "" }, "cwd"],
    ["code_root that is not sha256 hex", { code_root: "ABC" }, "code_root"],
    ["pid NaN", { pid: Number.NaN }, "pid"],
    ["pid 0", { pid: 0 }, "pid"],
    ["negative pid", { pid: -3 }, "pid"],
    ["float pid", { pid: 1.5 }, "pid"],
    ["string pid", { pid: "12" }, "pid"],
    ["ppid NaN", { ppid: Number.NaN }, "ppid"],
    ["ppid 0", { ppid: 0 }, "ppid"],
    ["negative ppid", { ppid: -1 }, "ppid"],
    ["float ppid", { ppid: 2.5 }, "ppid"],
    ["string ppid", { ppid: "7" }, "ppid"],
    ["pid_start that is a number", { pid_start: 123 }, "pid_start"],
    ["stdin_is_tty that is a string", { stdin_is_tty: "no" }, "stdin_is_tty"],
    ["replay missing", { replay: undefined }, "replay"],
    ["env that is an array", { env: ["A=1"] }, "env"],
    ["env that is null", { env: null }, "env"],
    ["env value that is a number", { env: { A: 1 } }, "env variable A"],
    ["257 env variables", { env: manyVars(257) }, "257 variables"],
    ["env of 65537 bytes", { env: { K: "v".repeat(65536) } }, "65537 bytes"],
    ["resume_ticket that is a number", { resume_ticket: 5 }, "resume_ticket"],
    ["resume_ticket of 4097 bytes", { resume_ticket: "t".repeat(4097) }, "resume_ticket"],
    ["resume_ticket of 4098 bytes in 2049 characters", { resume_ticket: "\u00e9".repeat(2049) }, "resume_ticket"],
  ])("refuses %s with hello_invalid naming the cause", (_label, over, fragment) => {
    const result = validateHello(hello(over), 1);
    expect(result).toMatchObject({ ok: false, code: "hello_invalid" });
    expect((result as { cause: string }).cause).toContain(fragment);
  });

  test("the limits are inclusive: 256 variables, 65536 env bytes and a 4096-byte ticket pass", () => {
    expect(validateHello(hello({ env: manyVars(256) }), 1)).toMatchObject({ ok: true });
    expect(validateHello(hello({ env: { K: "v".repeat(65535) } }), 1)).toMatchObject({ ok: true });
    expect(validateHello(hello({ resume_ticket: "t".repeat(4096) }), 1)).toMatchObject({ ok: true });
  });

  test("refuses a value that is not an object", () => {
    for (const v of [null, "x", 3, [hello()]]) {
      expect(validateHello(v, 1)).toMatchObject({ ok: false, code: "hello_invalid" });
    }
  });

  test("the validated hello carries only the known fields and an env with no prototype", () => {
    const h = accepted(validateHello(hello({ unknown_field: "x", injected: { a: 1 }, env: { PATH: "p" } }), 1));
    expect(Object.keys(h).sort()).toEqual(
      [
        "code_root",
        "cwd",
        "env",
        "family",
        "pid",
        "pid_start",
        "ppid",
        "ppid_start",
        "proto",
        "relay_version",
        "replay",
        "stdin_is_tty",
      ].sort(),
    );
    expect(Object.getPrototypeOf(h.env)).toBeNull();
    expect(h.env.PATH).toBe("p");
  });

  test("an env variable named like an Object.prototype member stays plain data", () => {
    const raw = JSON.parse('{"toString":"t","__proto__":"z","hasOwnProperty":"h"}');
    const { env } = accepted(validateHello(hello({ env: raw }), 1));
    expect(env["toString"]).toBe("t");
    expect(Object.keys(env).sort()).toEqual(["__proto__", "hasOwnProperty", "toString"]);
  });

  test("an env with no variable named toString does not inherit one", () => {
    const { env } = accepted(validateHello(hello({ env: { PATH: "p" } }), 1));
    expect((env as Record<string, unknown>).toString).toBeUndefined();
  });

  test("the resume_ticket is kept when present and absent from the key list when not", () => {
    const withTicket = accepted(validateHello(hello({ resume_ticket: "t" }), 1));
    const without = accepted(validateHello(hello(), 1));
    expect(withTicket.resume_ticket).toBe("t");
    expect("resume_ticket" in without).toBe(false);
  });

  test("parseHello decodes the wire payload and reports a payload that is not JSON as hello_invalid", () => {
    expect(parseHello(Buffer.from(JSON.stringify(hello())), 1)).toMatchObject({ ok: true });
    expect(parseHello(Buffer.from("{oops"), 1)).toMatchObject({ ok: false, code: "hello_invalid" });
  });
});

describe("resume ticket", () => {
  const claims: TicketClaims = {
    v: 1,
    family: "peers",
    relay_pid: 4242,
    relay_pid_start: "133750000000000000",
    writer_generation: JSON.stringify({ platform: "win32", pid: 4242, creationUtc: "2026-11-08T17:22:36.7733341Z" }),
    instance_token: "tok",
    peer_id: "peer-1",
    group_id: "g",
    notified_hwm: 17,
    issued_at: 1_700_000_000_000,
  };
  const expected = { relayPid: 4242, relayPidStart: "133750000000000000", family: "peers" };

  test("a minted ticket is <claims>.<mac> and verifies against the same hello facts", () => {
    const ticket = mintTicket(key, claims);
    expect(ticket.split(".")).toHaveLength(2);
    expect(verifyTicket(key, ticket, expected)).toEqual({ ok: true, claims });
  });

  test("the notice claims travel inside the MAC and are absent when not set", () => {
    const withNotice: TicketClaims = { ...claims, notice_at: 1_700_000_100_000, outages: 3 };
    expect(verifyTicket(key, mintTicket(key, withNotice), expected)).toEqual({ ok: true, claims: withNotice });
    const parsed = verifyTicket(key, mintTicket(key, claims), expected) as { claims: TicketClaims };
    expect("notice_at" in parsed.claims || "outages" in parsed.claims).toBe(false);
  });

  test("the MAC covers the claims: editing them without re-signing is refused", () => {
    const [body, mac] = mintTicket(key, claims).split(".") as [string, string];
    const edited = Buffer.from(body, "base64url").toString().replace('"peer-1"', '"peer-2"');
    const result = verifyTicket(key, `${b64u(Buffer.from(edited))}.${mac}`, expected);
    expect(result).toMatchObject({ ok: false });
    expect((result as { cause: string }).cause).toContain("mac");
  });

  test("a ticket signed with another key is refused", () => {
    expect(verifyTicket(Buffer.alloc(32, 5), mintTicket(key, claims), expected)).toMatchObject({ ok: false });
  });

  test.each([
    ["relay_pid", { ...expected, relayPid: 4243 }],
    ["relay_pid_start", { ...expected, relayPidStart: "133750000000000001" }],
    ["family", { ...expected, family: "roadmap" }],
  ])("a ticket whose %s differs from the hello is refused", (field, wrong) => {
    const result = verifyTicket(key, mintTicket(key, claims), wrong);
    expect(result).toMatchObject({ ok: false });
    expect((result as { cause: string }).cause).toContain(field);
  });

  test("a validly signed ticket of another version is refused", () => {
    const future = mintTicket(key, { ...claims, v: 2 } as unknown as TicketClaims);
    expect(verifyTicket(key, future, expected)).toMatchObject({ ok: false });
  });

  test.each(["", "abc", "a.b.c", "a.", ".b"])("malformed ticket %p is refused", (ticket) => {
    expect(verifyTicket(key, ticket, expected)).toMatchObject({ ok: false });
  });

  test.each([["null"], ["[]"], ['"text"'], ["7"]])("a validly signed ticket whose claims are %s is refused, not thrown", (json) => {
    const forged = mintTicket(key, JSON.parse(json) as TicketClaims);
    const result = verifyTicket(key, forged, expected);
    expect(result).toMatchObject({ ok: false });
  });

  test("the MAC carries a domain prefix: a MAC over the bare claims is refused", () => {
    const json = Buffer.from(JSON.stringify(claims));
    const bare = `${b64u(json)}.${b64u(createHmac("sha256", key).update(json).digest())}`;
    expect(verifyTicket(key, bare, expected)).toMatchObject({ ok: false });
    const domained = createHmac("sha256", key).update("kory-mcp-v1|ticket|").update(json).digest();
    expect(verifyTicket(key, `${b64u(json)}.${b64u(domained)}`, expected)).toMatchObject({ ok: true });
  });

  test("a claims segment with non-zero trailing bits is refused although it decodes to the same bytes", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const padded = (id: string) => ({ ...claims, peer_id: id });
    const id = ["p1", "p12", "p123"].find(
      (candidate) => Buffer.from(JSON.stringify(padded(candidate))).length % 3 !== 0,
    ) as string;
    const [body, mac] = mintTicket(key, padded(id)).split(".") as [string, string];
    const last = alphabet.indexOf(body.slice(-1));
    const altered = `${body.slice(0, -1)}${alphabet[last ^ 1]}`;
    expect(Buffer.from(altered, "base64url").equals(Buffer.from(body, "base64url"))).toBe(true);
    expect(verifyTicket(key, `${body}.${mac}`, expected)).toMatchObject({ ok: true });
    expect(verifyTicket(key, `${altered}.${mac}`, expected)).toMatchObject({ ok: false });
  });

  test("a ticket MAC with non-zero trailing bits is refused", () => {
    const [body] = mintTicket(key, claims).split(".") as [string];
    expect(verifyTicket(key, `${body}.${"A".repeat(42)}B`, expected)).toMatchObject({ ok: false });
  });

  test("a padded base64url ticket is refused", () => {
    const [body, mac] = mintTicket(key, claims).split(".") as [string, string];
    expect(verifyTicket(key, `${body}=.${mac}`, expected)).toMatchObject({ ok: false });
  });
});

describe("control role and the relay side of the handshake", () => {
  const nonce = Buffer.from(hs.relay_nonce, "base64url");
  const offered = { protoMin: 1, protoMax: 1 };

  test("buildAuth reproduces the fixture AUTH payload byte for byte", () => {
    const built = buildAuth(key, challenge, { nonce });
    expect(built.payload.toString()).toBe(hs.auth_payload);
    expect(built.relayNonce).toBe(hs.relay_nonce);
  });

  test("a control AUTH carries the control MAC and verifies as control only", () => {
    const control = buildAuth(key, challenge, { nonce, role: "control" });
    expect(JSON.parse(control.payload.toString()).mac).toBe(hs.control_mac_of_relay_message);
    expect(verifyAuth(key, challenge, control.payload, "control")).toMatchObject({ ok: true });
    expect(verifyAuth(key, challenge, control.payload)).toMatchObject({ ok: false, reason: "bad_mac" });
    expect(verifyAuth(key, challenge, control.payload, "relay")).toMatchObject({ ok: false, reason: "bad_mac" });
  });

  test("a relay AUTH does not verify as control", () => {
    expect(verifyAuth(key, challenge, authPayload, "control")).toMatchObject({ ok: false, reason: "bad_mac" });
  });

  test("the relay accepts the fixture AUTH_OK", () => {
    expect(verifyAuthOk(key, challenge, authPayload, hs.relay_nonce, authOkPayload, offered)).toEqual({
      ok: true,
      proto: 1,
    });
  });

  test.each([
    ["another key", () => verifyAuthOk(Buffer.alloc(32, 9), challenge, authPayload, hs.relay_nonce, authOkPayload, offered)],
    [
      "another relay nonce",
      () => verifyAuthOk(key, challenge, authPayload, b64u(Buffer.alloc(32, 1)), authOkPayload, offered),
    ],
    [
      "another AUTH payload",
      () => verifyAuthOk(key, challenge, Buffer.from(`${hs.auth_payload} `), hs.relay_nonce, authOkPayload, offered),
    ],
    [
      "a MAC with a bit changed",
      () =>
        verifyAuthOk(
          key,
          challenge,
          authPayload,
          hs.relay_nonce,
          Buffer.from(hs.auth_ok_payload.replace("zuAU", "zuAV")),
          offered,
        ),
    ],
    ["a payload that is not JSON", () => verifyAuthOk(key, challenge, authPayload, hs.relay_nonce, Buffer.from("x"), offered)],
    [
      "a payload with no MAC",
      () => verifyAuthOk(key, challenge, authPayload, hs.relay_nonce, Buffer.from('{"proto":1}'), offered),
    ],
  ])("the relay refuses an AUTH_OK with %s", (_label, run) => {
    expect(run()).toMatchObject({ ok: false });
  });

  test("a validly signed AUTH_OK for a version the relay did not offer is refused", () => {
    const outside = buildAuthOk(key, challenge, authPayload, hs.relay_nonce, 2);
    const result = verifyAuthOk(key, challenge, authPayload, hs.relay_nonce, outside, offered);
    expect(result).toMatchObject({ ok: false });
    expect((result as { cause: string }).cause).toContain("outside 1..1");
  });
});
