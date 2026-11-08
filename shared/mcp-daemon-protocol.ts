import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const FRAME_TYPE = {
  CHALLENGE: 0x01,
  AUTH: 0x02,
  AUTH_OK: 0x03,
  HELLO: 0x04,
  WELCOME: 0x05,
  MCP: 0x10,
  TICKET: 0x11,
  BYE: 0x12,
  PING: 0x13,
  PONG: 0x14,
  ERROR: 0x15,
  CONTROL: 0x20,
} as const;

export const MAX_PAYLOAD = 16 * 1024 * 1024;
export const PRE_AUTH_MAX_PAYLOAD = 64 * 1024;
export const PROTO_MIN = 1;
export const PROTO_MAX = 1;
export const COUNTER_LIMIT = 1n << 48n;

const TAG_BYTES = 16;
const MIN_SEALED_LEN = 1 + TAG_BYTES;
const NONCE_BYTES = 32;
const MAC_BYTES = 32;
const HELLO_MAX_ENV_VARS = 256;
const HELLO_MAX_ENV_BYTES = 64 * 1024;
const HELLO_MAX_TICKET_BYTES = 4096;

export type ViolationCode = "frame_length" | "payload_too_large" | "seal_auth" | "counter_exhausted";

export class ProtocolViolation extends Error {
  constructor(
    readonly code: ViolationCode,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolViolation";
  }
}

export interface Frame {
  type: number;
  payload: Buffer;
}

export function encodeFrame(type: number, payload: Uint8Array): Buffer {
  if (payload.length > MAX_PAYLOAD) {
    throw new ProtocolViolation("payload_too_large", `payload of ${payload.length} bytes exceeds ${MAX_PAYLOAD}`);
  }
  const header = Buffer.alloc(5);
  header.writeUInt32LE(payload.length + 1, 0);
  header.writeUInt8(type, 4);
  return Buffer.concat([header, payload]);
}

abstract class FrameReader {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(public maxPayload: number) {}

  protected abstract checkLength(len: number): void;
  protected abstract decodeWire(wire: Buffer): Frame;

  push(chunk: Uint8Array): Frame[] {
    if (chunk.length > 0) {
      this.chunks.push(Buffer.from(chunk));
      this.size += chunk.length;
    }
    const out: Frame[] = [];
    for (;;) {
      if (this.size < 4) break;
      if ((this.chunks[0] as Buffer).length < 4) this.flatten();
      const len = (this.chunks[0] as Buffer).readUInt32LE(0);
      this.checkLength(len);
      if (this.size < 4 + len) break;
      this.flatten();
      const buf = this.chunks[0] as Buffer;
      out.push(this.decodeWire(buf.subarray(0, 4 + len)));
      const rest = buf.subarray(4 + len);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.size = rest.length;
    }
    return out;
  }

  private flatten(): void {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
  }
}

export class PlainFrameDecoder extends FrameReader {
  constructor(maxPayload: number = PRE_AUTH_MAX_PAYLOAD) {
    super(maxPayload);
  }

  protected checkLength(len: number): void {
    if (len === 0 || len - 1 > this.maxPayload) {
      throw new ProtocolViolation("frame_length", `frame length ${len} (payload limit ${this.maxPayload})`);
    }
  }

  protected decodeWire(wire: Buffer): Frame {
    return { type: wire.readUInt8(4), payload: wire.subarray(5) };
  }
}

export class SealedFrameDecoder extends FrameReader {
  constructor(
    private readonly opener: Opener,
    maxPayload: number = MAX_PAYLOAD,
  ) {
    super(maxPayload);
  }

  protected checkLength(len: number): void {
    if (len < MIN_SEALED_LEN || len - MIN_SEALED_LEN > this.maxPayload) {
      throw new ProtocolViolation(
        "frame_length",
        `sealed frame length ${len} outside ${MIN_SEALED_LEN}..${this.maxPayload + MIN_SEALED_LEN}`,
      );
    }
  }

  protected decodeWire(wire: Buffer): Frame {
    return this.opener.open(wire);
  }
}

function nonceFor(counter: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

export class Sealer {
  private counter: bigint;

  constructor(
    private readonly key: Buffer,
    startCounter = 0n,
  ) {
    this.counter = startCounter;
  }

  seal(type: number, payload: Uint8Array): Buffer {
    if (payload.length > MAX_PAYLOAD) {
      throw new ProtocolViolation("payload_too_large", `payload of ${payload.length} bytes exceeds ${MAX_PAYLOAD}`);
    }
    if (this.counter >= COUNTER_LIMIT) {
      throw new ProtocolViolation("counter_exhausted", "sealed channel counter reached 2^48");
    }
    const header = Buffer.alloc(4);
    header.writeUInt32LE(1 + payload.length + TAG_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonceFor(this.counter), { authTagLength: TAG_BYTES });
    cipher.setAAD(header);
    const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from([type]), payload])), cipher.final()]);
    this.counter += 1n;
    return Buffer.concat([header, body, cipher.getAuthTag()]);
  }
}

export class Opener {
  private counter: bigint;

  constructor(
    private readonly key: Buffer,
    startCounter = 0n,
  ) {
    this.counter = startCounter;
  }

  open(wire: Buffer): Frame {
    if (this.counter >= COUNTER_LIMIT) {
      throw new ProtocolViolation("counter_exhausted", "sealed channel counter reached 2^48");
    }
    if (wire.length < 4 + MIN_SEALED_LEN || wire.readUInt32LE(0) !== wire.length - 4) {
      throw new ProtocolViolation("frame_length", `sealed frame of ${wire.length} bytes is inconsistent`);
    }
    const header = wire.subarray(0, 4);
    const tag = wire.subarray(wire.length - TAG_BYTES);
    const ciphertext = wire.subarray(4, wire.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonceFor(this.counter), { authTagLength: TAG_BYTES });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (e) {
      throw new ProtocolViolation("seal_auth", `sealed frame authentication failed: ${(e as Error).message}`);
    }
    this.counter += 1n;
    return { type: plain.readUInt8(0), payload: plain.subarray(1) };
  }
}

export function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

// Buffer.from(_, "base64url") skips invalid characters and accepts padding;
// re-encoding rejects every form that is not the canonical unpadded text.
function decodeB64u(text: unknown, bytes?: number): Buffer | null {
  if (typeof text !== "string") return null;
  const raw = Buffer.from(text, "base64url");
  if (raw.toString("base64url") !== text) return null;
  if (bytes !== undefined && raw.length !== bytes) return null;
  return raw;
}

function sha256b64u(payload: Uint8Array): string {
  return b64u(createHash("sha256").update(payload).digest());
}

export type MacRole = "relay" | "daemon" | "control";

export function handshakeMac(key: Buffer, role: MacRole, parts: readonly string[]): Buffer {
  return createHmac("sha256", key).update(`kory-mcp-v1|${role}|${parts.join("|")}`).digest();
}

export interface Challenge {
  payload: Buffer;
  daemonNonce: string;
  protoMin: number;
  protoMax: number;
}

export function buildChallenge(opts: {
  daemonInstance: string;
  daemonVersion: string;
  protoMin?: number;
  protoMax?: number;
  nonce?: Buffer;
}): Challenge {
  const nonce = opts.nonce ?? randomBytes(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) throw new Error(`daemon nonce must be ${NONCE_BYTES} bytes`);
  const protoMin = opts.protoMin ?? PROTO_MIN;
  const protoMax = opts.protoMax ?? PROTO_MAX;
  const daemonNonce = b64u(nonce);
  const payload = Buffer.from(
    JSON.stringify({
      daemon_instance: opts.daemonInstance,
      daemon_nonce: daemonNonce,
      daemon_version: opts.daemonVersion,
      proto_max: protoMax,
      proto_min: protoMin,
    }),
  );
  return { payload, daemonNonce, protoMin, protoMax };
}

export function negotiateProto(aMin: number, aMax: number, bMin: number, bMax: number): number | null {
  const highest = Math.min(aMax, bMax);
  return highest >= Math.max(aMin, bMin) ? highest : null;
}

export function relayMac(
  key: Buffer,
  challenge: Challenge,
  relayNonce: string,
  protoMin: number,
  protoMax: number,
  role: "relay" | "control" = "relay",
): Buffer {
  return handshakeMac(key, role, [
    challenge.daemonNonce,
    relayNonce,
    sha256b64u(challenge.payload),
    String(protoMin),
    String(protoMax),
  ]);
}

export type AuthResult =
  | { ok: true; proto: number; relayNonce: string }
  | { ok: false; reason: "malformed" | "bad_mac" | "proto_mismatch"; cause: string };

function isProto(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
}

export function buildAuth(
  key: Buffer,
  challenge: Challenge,
  opts: { role?: "relay" | "control"; protoMin?: number; protoMax?: number; nonce?: Buffer } = {},
): { payload: Buffer; relayNonce: string } {
  const nonce = opts.nonce ?? randomBytes(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) throw new Error(`relay nonce must be ${NONCE_BYTES} bytes`);
  const [protoMin, protoMax] = [opts.protoMin ?? PROTO_MIN, opts.protoMax ?? PROTO_MAX];
  const relayNonce = b64u(nonce);
  const mac = b64u(relayMac(key, challenge, relayNonce, protoMin, protoMax, opts.role));
  const payload = Buffer.from(
    JSON.stringify({ mac, proto_max: protoMax, proto_min: protoMin, relay_nonce: relayNonce }),
  );
  return { payload, relayNonce };
}

export type AuthOkResult = { ok: true; proto: number } | { ok: false; cause: string };

// The relay side of step 4 (design 4.3): the daemon must prove the key before
// the relay sends anything else.
export function verifyAuthOk(
  key: Buffer,
  challenge: Challenge,
  authPayload: Buffer,
  relayNonce: string,
  authOkPayload: Buffer,
  offered: { protoMin: number; protoMax: number },
): AuthOkResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authOkPayload.toString("utf8"));
  } catch (e) {
    return { ok: false, cause: `AUTH_OK is not JSON: ${(e as Error).message}` };
  }
  const ok = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const presented = decodeB64u(ok.mac, MAC_BYTES);
  if (presented === null || !isProto(ok.proto)) return { ok: false, cause: "AUTH_OK has no valid mac and proto" };
  if (!timingSafeEqual(daemonMac(key, challenge, authPayload, relayNonce, ok.proto), presented)) {
    return { ok: false, cause: "the listener did not prove it knows the shared key" };
  }
  if (ok.proto < offered.protoMin || ok.proto > offered.protoMax) {
    return { ok: false, cause: `the daemon selected protocol ${ok.proto}, outside ${offered.protoMin}..${offered.protoMax}` };
  }
  return { ok: true, proto: ok.proto };
}

export function verifyAuth(
  key: Buffer,
  challenge: Challenge,
  authPayload: Buffer,
  role: "relay" | "control" = "relay",
): AuthResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authPayload.toString("utf8"));
  } catch (e) {
    return { ok: false, reason: "malformed", cause: `AUTH is not JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "malformed", cause: "AUTH is not an object" };
  }
  const auth = parsed as Record<string, unknown>;
  const { proto_min: protoMin, proto_max: protoMax } = auth;
  if (!isProto(protoMin) || !isProto(protoMax) || protoMin > protoMax) {
    return { ok: false, reason: "malformed", cause: "AUTH proto_min/proto_max are not a valid range" };
  }
  if (decodeB64u(auth.relay_nonce, NONCE_BYTES) === null) {
    return { ok: false, reason: "malformed", cause: `AUTH relay_nonce is not ${NONCE_BYTES} bytes of base64url` };
  }
  const presented = decodeB64u(auth.mac, MAC_BYTES);
  if (presented === null) {
    return { ok: false, reason: "malformed", cause: `AUTH mac is not ${MAC_BYTES} bytes of base64url` };
  }
  const relayNonce = auth.relay_nonce as string;
  const expected = relayMac(key, challenge, relayNonce, protoMin, protoMax, role);
  if (!timingSafeEqual(expected, presented)) {
    return { ok: false, reason: "bad_mac", cause: "AUTH mac does not verify" };
  }
  const proto = negotiateProto(challenge.protoMin, challenge.protoMax, protoMin, protoMax);
  if (proto === null) {
    return {
      ok: false,
      reason: "proto_mismatch",
      cause: `no common version between ${challenge.protoMin}..${challenge.protoMax} and ${protoMin}..${protoMax}`,
    };
  }
  return { ok: true, proto, relayNonce };
}

function daemonMac(
  key: Buffer,
  challenge: Challenge,
  authPayload: Buffer,
  relayNonce: string,
  proto: number,
): Buffer {
  return handshakeMac(key, "daemon", [
    relayNonce,
    challenge.daemonNonce,
    sha256b64u(challenge.payload),
    sha256b64u(authPayload),
    String(proto),
  ]);
}

export function buildAuthOk(
  key: Buffer,
  challenge: Challenge,
  authPayload: Buffer,
  relayNonce: string,
  proto: number,
): Buffer {
  return Buffer.from(JSON.stringify({ mac: b64u(daemonMac(key, challenge, authPayload, relayNonce, proto)), proto }));
}

export interface SessionKeys {
  r2d: Buffer;
  d2r: Buffer;
}

export function deriveSessionKeys(
  key: Buffer,
  challenge: Challenge,
  authPayload: Buffer,
  authOkPayload: Buffer,
  relayNonce: string,
): SessionKeys {
  const th = createHash("sha256").update(challenge.payload).update(authPayload).update(authOkPayload).digest();
  const salt = Buffer.concat([
    Buffer.from(challenge.daemonNonce, "base64url"),
    Buffer.from(relayNonce, "base64url"),
  ]);
  const derive = (label: string): Buffer =>
    Buffer.from(hkdfSync("sha256", key, salt, Buffer.concat([Buffer.from(label), th]), 32));
  return { r2d: derive("kory-mcp-v1 r2d"), d2r: derive("kory-mcp-v1 d2r") };
}

export interface Hello {
  proto: number;
  family: "peers" | "roadmap";
  relay_version: string;
  code_root: string;
  pid: number;
  ppid: number;
  pid_start: string;
  ppid_start: string;
  cwd: string;
  stdin_is_tty: boolean;
  env: Record<string, string>;
  resume_ticket?: string;
  replay: boolean;
}

export type HelloResult =
  | { ok: true; hello: Hello }
  | { ok: false; code: "hello_invalid"; cause: string };

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

function positivePid(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

export function validateHello(value: unknown, negotiatedProto: number): HelloResult {
  const bad = (cause: string): HelloResult => ({ ok: false, code: "hello_invalid", cause });
  if (typeof value !== "object" || value === null || Array.isArray(value)) return bad("hello is not an object");
  const h = value as Record<string, unknown>;
  if (h.proto !== negotiatedProto) return bad(`proto ${String(h.proto)} differs from the negotiated ${negotiatedProto}`);
  if (h.family !== "peers" && h.family !== "roadmap") return bad("family is not peers or roadmap");
  if (typeof h.relay_version !== "string") return bad("relay_version is not a string");
  if (typeof h.code_root !== "string" || !/^[0-9a-f]{64}$/.test(h.code_root)) {
    return bad("code_root is not a lowercase sha256 hex string");
  }
  if (!positivePid(h.pid)) return bad("pid is not a positive integer");
  if (!positivePid(h.ppid)) return bad("ppid is not a positive integer");
  if (typeof h.pid_start !== "string") return bad("pid_start is not a string");
  if (typeof h.ppid_start !== "string") return bad("ppid_start is not a string");
  if (typeof h.cwd !== "string" || !ABSOLUTE_PATH.test(h.cwd)) return bad("cwd is not an absolute path");
  if (typeof h.stdin_is_tty !== "boolean") return bad("stdin_is_tty is not a boolean");
  if (typeof h.replay !== "boolean") return bad("replay is not a boolean");
  if (typeof h.env !== "object" || h.env === null || Array.isArray(h.env)) return bad("env is not an object");
  const entries = Object.entries(h.env as Record<string, unknown>);
  if (entries.length > HELLO_MAX_ENV_VARS) return bad(`env has ${entries.length} variables, above ${HELLO_MAX_ENV_VARS}`);
  let envBytes = 0;
  const env: Record<string, string> = Object.create(null);
  for (const [name, val] of entries) {
    if (typeof val !== "string") return bad(`env variable ${name} is not a string`);
    envBytes += Buffer.byteLength(name) + Buffer.byteLength(val);
    env[name] = val;
  }
  if (envBytes > HELLO_MAX_ENV_BYTES) return bad(`env is ${envBytes} bytes, above ${HELLO_MAX_ENV_BYTES}`);
  if (h.resume_ticket !== undefined) {
    if (typeof h.resume_ticket !== "string") return bad("resume_ticket is not a string");
    if (Buffer.byteLength(h.resume_ticket) > HELLO_MAX_TICKET_BYTES) {
      return bad(`resume_ticket is above ${HELLO_MAX_TICKET_BYTES} bytes`);
    }
  }
  return {
    ok: true,
    hello: {
      proto: h.proto,
      family: h.family,
      relay_version: h.relay_version,
      code_root: h.code_root,
      pid: h.pid,
      ppid: h.ppid,
      pid_start: h.pid_start,
      ppid_start: h.ppid_start,
      cwd: h.cwd,
      stdin_is_tty: h.stdin_is_tty,
      env,
      replay: h.replay,
      ...(h.resume_ticket !== undefined ? { resume_ticket: h.resume_ticket } : {}),
    },
  };
}

export function parseHello(payload: Buffer, negotiatedProto: number): HelloResult {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch (e) {
    return { ok: false, code: "hello_invalid", cause: `hello is not JSON: ${(e as Error).message}` };
  }
  return validateHello(value, negotiatedProto);
}

export interface TicketClaims {
  v: 1;
  family: "peers";
  relay_pid: number;
  relay_pid_start: string;
  writer_generation: unknown;
  instance_token: string;
  peer_id: string;
  group_id: string;
  notified_hwm: number;
  issued_at: number | string;
}

const TICKET_MAC_DOMAIN = "kory-mcp-v1|ticket|";

function ticketMac(key: Buffer, json: Buffer): Buffer {
  return createHmac("sha256", key).update(TICKET_MAC_DOMAIN).update(json).digest();
}

export function mintTicket(key: Buffer, claims: TicketClaims): string {
  const json = Buffer.from(JSON.stringify(claims));
  return `${b64u(json)}.${b64u(ticketMac(key, json))}`;
}

export type TicketResult = { ok: true; claims: TicketClaims } | { ok: false; cause: string };

export function verifyTicket(
  key: Buffer,
  ticket: string,
  expected: { relayPid: number; relayPidStart: string; family: string },
): TicketResult {
  const refuse = (cause: string): TicketResult => ({ ok: false, cause });
  const parts = ticket.split(".");
  if (parts.length !== 2) return refuse("ticket is not <claims>.<mac>");
  const json = decodeB64u(parts[0]);
  const presented = decodeB64u(parts[1], MAC_BYTES);
  if (json === null || presented === null) return refuse("ticket is not canonical base64url");
  if (!timingSafeEqual(ticketMac(key, json), presented)) {
    return refuse("ticket mac does not verify");
  }
  let claims: TicketClaims;
  try {
    claims = JSON.parse(json.toString("utf8")) as TicketClaims;
  } catch (e) {
    return refuse(`ticket claims are not JSON: ${(e as Error).message}`);
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    return refuse("ticket claims are not an object");
  }
  if (claims.v !== 1) return refuse(`ticket version ${String(claims.v)} is not 1`);
  if (claims.family !== expected.family) return refuse("ticket family differs from the hello");
  if (claims.relay_pid !== expected.relayPid) return refuse("ticket relay_pid differs from the hello pid");
  if (claims.relay_pid_start !== expected.relayPidStart) {
    return refuse("ticket relay_pid_start differs from the hello pid_start");
  }
  return { ok: true, claims };
}
