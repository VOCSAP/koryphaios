import type { DaemonClock } from "./mcp-daemon-server.ts";
import {
  FRAME_TYPE,
  Opener,
  PRE_AUTH_MAX_PAYLOAD,
  PROTO_MAX,
  PROTO_MIN,
  PlainFrameDecoder,
  SealedFrameDecoder,
  Sealer,
  b64u,
  buildAuth,
  deriveSessionKeys,
  encodeFrame,
  verifyAuthOk,
  type Challenge,
  type Frame,
} from "./mcp-daemon-protocol.ts";

const STAGE_MS = 3000;

export type ControlOutcome =
  | { kind: "free" }
  | { kind: "foreign"; cause: string }
  | { kind: "reply"; body: Record<string, unknown> };

export interface ControlSocket {
  /** Returns how many bytes were accepted; the rest must be offered again after `drain`. */
  write(data: Uint8Array): number;
  terminate(): void;
}

export interface ControlHandlers {
  open(socket: ControlSocket): void;
  data(socket: ControlSocket, chunk: Uint8Array): void;
  drain(socket: ControlSocket): void;
  close(): void;
  error(socket: ControlSocket, error: Error): void;
}

/** Opens the connection to the daemon; replaced in tests by a socket that records what the client writes. */
export type ControlConnect = (port: number, handlers: ControlHandlers) => Promise<unknown>;

const bunConnect: ControlConnect = (port, handlers) => Bun.connect({ hostname: "127.0.0.1", port, socket: handlers });

export interface ControlRequestOptions {
  port: number;
  key: Buffer;
  op: "status" | "stop";
  clock?: DaemonClock;
  connect?: ControlConnect;
}

const realClock: DaemonClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function parseChallenge(payload: Buffer): Challenge | string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
  } catch (e) {
    return `CHALLENGE is not JSON: ${(e as Error).message}`;
  }
  const { daemon_nonce: nonce, proto_min: protoMin, proto_max: protoMax } = parsed;
  if (typeof nonce !== "string" || Buffer.from(nonce, "base64url").length !== 32 || b64u(Buffer.from(nonce, "base64url")) !== nonce) {
    return "CHALLENGE daemon_nonce is not 32 bytes of base64url";
  }
  if (!Number.isSafeInteger(protoMin) || !Number.isSafeInteger(protoMax)) return "CHALLENGE has no version range";
  return { payload, daemonNonce: nonce, protoMin: protoMin as number, protoMax: protoMax as number };
}

/**
 * One authenticated request to the daemon on `port`, as the control client.
 * A refused connection means the port is free; anything else that does not end
 * in a reply means another program (or a daemon with another key) holds it.
 */
export function controlRequest(opts: ControlRequestOptions): Promise<ControlOutcome> {
  const clock = opts.clock ?? realClock;
  return new Promise<ControlOutcome>((resolve) => {
    let settled = false;
    let timer: unknown;
    let socket: ControlSocket | undefined;
    let stage: "challenge" | "auth_ok" | "reply" = "challenge";
    let decoder: PlainFrameDecoder | SealedFrameDecoder = new PlainFrameDecoder();
    let sealer: Sealer | undefined;
    let challenge: Challenge | undefined;
    let auth: { payload: Buffer; relayNonce: string } | undefined;
    const pending: Uint8Array[] = [];

    const flush = (): void => {
      while (pending.length > 0 && socket !== undefined && !settled) {
        const head = pending[0] as Uint8Array;
        const written = socket.write(head);
        if (written < head.length) {
          pending[0] = head.subarray(Math.max(written, 0));
          return;
        }
        pending.shift();
      }
    };
    const send = (data: Uint8Array): void => {
      pending.push(data);
      flush();
    };

    const finish = (outcome: ControlOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      socket?.terminate();
      resolve(outcome);
    };
    const foreign = (cause: string): void => finish({ kind: "foreign", cause });
    const arm = (): void => {
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = clock.setTimeout(() => foreign(`no answer at stage ${stage} within ${STAGE_MS} ms`), STAGE_MS);
    };

    const onFrame = (frame: Frame): void => {
      if (stage === "challenge") {
        if (frame.type !== FRAME_TYPE.CHALLENGE) return foreign(`expected CHALLENGE, got frame type ${frame.type}`);
        const parsed = parseChallenge(frame.payload);
        if (typeof parsed === "string") return foreign(parsed);
        challenge = parsed;
        auth = buildAuth(opts.key, parsed, { role: "control" });
        stage = "auth_ok";
        arm();
        send(encodeFrame(FRAME_TYPE.AUTH, auth.payload));
        return;
      }
      if (stage === "auth_ok") {
        if (frame.type !== FRAME_TYPE.AUTH_OK || challenge === undefined || auth === undefined) {
          return foreign(`expected AUTH_OK, got frame type ${frame.type}`);
        }
        const verdict = verifyAuthOk(opts.key, challenge, auth.payload, auth.relayNonce, frame.payload, {
          protoMin: PROTO_MIN,
          protoMax: PROTO_MAX,
        });
        if (!verdict.ok) return foreign(verdict.cause);
        const keys = deriveSessionKeys(opts.key, challenge, auth.payload, frame.payload, auth.relayNonce);
        sealer = new Sealer(keys.r2d);
        decoder = new SealedFrameDecoder(new Opener(keys.d2r), PRE_AUTH_MAX_PAYLOAD);
        stage = "reply";
        arm();
        send(sealer.seal(FRAME_TYPE.CONTROL, Buffer.from(JSON.stringify({ op: opts.op }))));
        return;
      }
      if (frame.type !== FRAME_TYPE.CONTROL) return foreign(`daemon answered frame type ${frame.type}, not CONTROL`);
      try {
        finish({ kind: "reply", body: JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown> });
      } catch (e) {
        foreign(`the control reply is not JSON: ${(e as Error).message}`);
      }
    };

    (opts.connect ?? bunConnect)(opts.port, {
      open(s) {
        socket = s;
        arm();
      },
      data(_s, chunk) {
        if (settled) return;
        let frames: Frame[];
        try {
          frames = decoder.push(chunk);
        } catch (e) {
          foreign(`bad frame: ${(e as Error).message}`);
          return;
        }
        for (const frame of frames) {
          const before = decoder;
          onFrame(frame);
          if (settled || decoder !== before) break;
        }
      },
      drain() {
        flush();
      },
      close() {
        foreign("the connection closed before a reply");
      },
      error(_s, error) {
        foreign(`socket error: ${error.message}`);
      },
    }).catch((e: unknown) => {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED") finish({ kind: "free" });
      else foreign(`cannot connect: ${e instanceof Error ? e.message : String(e)}`);
    });
  });
}
