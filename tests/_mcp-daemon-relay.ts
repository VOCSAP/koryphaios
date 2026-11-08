import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Socket } from "bun";
import {
  FRAME_TYPE,
  Opener,
  PlainFrameDecoder,
  SealedFrameDecoder,
  Sealer,
  b64u,
  deriveSessionKeys,
  encodeFrame,
  relayMac,
  type Challenge,
  type Frame,
} from "../shared/mcp-daemon-protocol.ts";
import { reachedWithin } from "./_bounded-await.ts";

export const RELAY_CODE_ROOT = "d".repeat(64);

export interface RelayHello {
  family: string;
  cwd: string;
  env: Record<string, string>;
  pid: number;
  ppid: number;
}

export type HelloReply =
  | { kind: "welcome"; sessionId: string; family: string; toolsHash: string }
  | { kind: "refused"; code: string; message: string }
  | { kind: "closed" };

export interface ToolReply {
  isError: boolean;
  text: string;
}

const WAIT_MS = 5000;

/** The relay half of the daemon protocol: connects with the shared key found at `keyPath` (a relay creates it, the daemon never does), then speaks sealed frames. */
export class DaemonRelay {
  private queue: Frame[] = [];
  private waiting?: (value: Frame | "closed") => void;
  private decoder: PlainFrameDecoder | SealedFrameDecoder = new PlainFrameDecoder();
  private sealer?: Sealer;
  private socket!: Socket<undefined>;
  private closed = false;
  private nextId = 0;

  static async open(port: number, keyPath: string): Promise<DaemonRelay> {
    const relay = new DaemonRelay();
    relay.socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data: (_socket, chunk) => relay.onData(chunk),
        close: () => relay.onClose(),
        error: () => relay.onClose(),
      },
    });
    await relay.authenticate(Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex"));
    return relay;
  }

  private onData(chunk: Uint8Array): void {
    this.queue.push(...this.decoder.push(chunk));
    const next = this.waiting ? this.queue.shift() : undefined;
    if (this.waiting && next) {
      const waiter = this.waiting;
      this.waiting = undefined;
      waiter(next);
    }
  }

  private onClose(): void {
    this.closed = true;
    const waiter = this.waiting;
    this.waiting = undefined;
    waiter?.("closed");
  }

  private async nextFrame(what: string): Promise<Frame | "closed"> {
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.closed) return "closed";
    return reachedWithin(new Promise<Frame | "closed">((resolve) => (this.waiting = resolve)), what, WAIT_MS);
  }

  private async authenticate(key: Buffer): Promise<void> {
    const challengeFrame = await this.nextFrame("CHALLENGE");
    if (challengeFrame === "closed" || challengeFrame.type !== FRAME_TYPE.CHALLENGE) {
      throw new Error("the daemon did not open with a CHALLENGE frame");
    }
    const parsed = JSON.parse(challengeFrame.payload.toString());
    const challenge: Challenge = {
      payload: challengeFrame.payload,
      daemonNonce: parsed.daemon_nonce,
      protoMin: parsed.proto_min,
      protoMax: parsed.proto_max,
    };
    const relayNonce = b64u(randomBytes(32));
    const authPayload = Buffer.from(
      JSON.stringify({
        mac: b64u(relayMac(key, challenge, relayNonce, 1, 1)),
        proto_max: 1,
        proto_min: 1,
        relay_nonce: relayNonce,
      }),
    );
    this.socket.write(encodeFrame(FRAME_TYPE.AUTH, authPayload));
    const authOk = await this.nextFrame("AUTH_OK");
    if (authOk === "closed" || authOk.type !== FRAME_TYPE.AUTH_OK) throw new Error("the daemon refused the handshake");
    const keys = deriveSessionKeys(key, challenge, authPayload, authOk.payload, relayNonce);
    this.sealer = new Sealer(keys.r2d);
    this.decoder = new SealedFrameDecoder(new Opener(keys.d2r));
  }

  private send(type: number, payload: string): void {
    this.socket.write((this.sealer as Sealer).seal(type, Buffer.from(payload)));
  }

  async hello(over: Partial<RelayHello> & { env: Record<string, string> }): Promise<HelloReply> {
    this.send(
      FRAME_TYPE.HELLO,
      JSON.stringify({
        proto: 1,
        family: "roadmap",
        relay_version: "0.1.0",
        code_root: RELAY_CODE_ROOT,
        pid: 4242,
        ppid: 100,
        pid_start: "133750000000000000",
        ppid_start: "",
        cwd: "/work/a",
        stdin_is_tty: false,
        replay: false,
        ...over,
      }),
    );
    for (;;) {
      const frame = await this.nextFrame("WELCOME or ERROR");
      if (frame === "closed") return { kind: "closed" };
      if (frame.type === FRAME_TYPE.WELCOME) {
        const welcome = JSON.parse(frame.payload.toString());
        return { kind: "welcome", sessionId: welcome.session_id, family: welcome.family, toolsHash: welcome.tools_hash };
      }
      if (frame.type === FRAME_TYPE.ERROR) {
        const refusal = JSON.parse(frame.payload.toString());
        return { kind: "refused", code: refusal.code, message: refusal.message };
      }
    }
  }

  async rpc(method: string, params?: unknown): Promise<{ result?: any; error?: any }> {
    const id = ++this.nextId;
    this.send(FRAME_TYPE.MCP, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    for (;;) {
      const frame = await this.nextFrame(`reply to ${method}`);
      if (frame === "closed") throw new Error(`connection closed while waiting for ${method}`);
      if (frame.type !== FRAME_TYPE.MCP) continue;
      const message = JSON.parse(frame.payload.toString());
      if (message.id === id) return message;
    }
  }

  async toolNames(): Promise<string[]> {
    const reply = await this.rpc("tools/list");
    return (reply.result.tools as Array<{ name: string }>).map((tool) => tool.name);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
    const reply = await this.rpc("tools/call", { name, arguments: args });
    if (reply.error) throw new Error(`${name} failed at the protocol level: ${JSON.stringify(reply.error)}`);
    return { isError: reply.result.isError === true, text: reply.result.content[0]?.text ?? "" };
  }

  close(): void {
    this.socket.end();
  }
}
