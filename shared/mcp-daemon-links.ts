import { createHash } from "node:crypto";
import type { Hello } from "./mcp-daemon-protocol.ts";

/** What the roadmap family needs of a peers session to act as its peer. */
export interface LinkedIdentity {
  peerId: string;
  instanceToken: string;
  projectKey: string;
  brokerUrl: string;
}

export interface LinkKey {
  socketHash: string;
  ppid: number;
  ppidStart: string;
}

export type LinkLookup =
  | { kind: "none" }
  | { kind: "one"; sessionId: string; identity: LinkedIdentity }
  | { kind: "many"; sessionIds: string[] };

export interface LinkIndex {
  /** `read` is asked at each lookup: null while the session holds no identity. Returns the removal. */
  register(sessionId: string, key: LinkKey, read: () => LinkedIdentity | null): () => void;
  find(key: LinkKey): LinkLookup;
}

/**
 * The two families of one Claude Code session share the socket, the parent pid and its start time.
 * An empty start time means "not measurable": a reused pid could not be told apart, so nothing links.
 */
export function linkKeyOf(hello: Pick<Hello, "env" | "ppid" | "ppid_start">): LinkKey | null {
  const socket = hello.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!socket || hello.ppid_start === "") return null;
  return { socketHash: createHash("sha256").update(socket).digest("hex"), ppid: hello.ppid, ppidStart: hello.ppid_start };
}

function sameKey(a: LinkKey, b: LinkKey): boolean {
  return a.socketHash === b.socketHash && a.ppid === b.ppid && a.ppidStart === b.ppidStart;
}

export function createLinkIndex(): LinkIndex {
  const entries = new Set<{ sessionId: string; key: LinkKey; read: () => LinkedIdentity | null }>();
  return {
    register(sessionId, key, read) {
      const entry = { sessionId, key, read };
      entries.add(entry);
      return () => void entries.delete(entry);
    },
    find(key) {
      const found: Array<{ sessionId: string; identity: LinkedIdentity }> = [];
      for (const entry of entries) {
        if (!sameKey(entry.key, key)) continue;
        const identity = entry.read();
        if (identity) found.push({ sessionId: entry.sessionId, identity });
      }
      const [first, ...rest] = found;
      if (!first) return { kind: "none" };
      if (rest.length === 0) return { kind: "one", sessionId: first.sessionId, identity: first.identity };
      return { kind: "many", sessionIds: found.map((f) => f.sessionId) };
    },
  };
}
