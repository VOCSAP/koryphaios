// EXPLORATION-graph-chat C25: context compilation + inference orchestration
// (desktop/src/main/graph-engine). Linear vs merge rendering (D3), budget
// elision (D8), anonymized judge, fan-out with an injected runner.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildJudgeSystem,
  compileContext,
  composeSinglePrompt,
  DEFAULT_JUDGE,
  GRAPH_CHAT_SYSTEM_PROMPT,
  GRAPH_JUDGE_PROMPT,
  GRAPH_JUDGE_SYSTEM_PROMPT,
  GRAPH_MAX_CONTEXT_CHARS,
  GRAPH_MERGE_SYSTEM_PROMPT,
  runInference
} from "../desktop/src/main/graph-engine.ts";
import type { GraphDoc, GraphNode } from "../desktop/src/shared/graph.ts";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-graph-engine-"));
  tmpDirs.push(d);
  return d;
}

let clock = 1000;
function n(
  id: string,
  parents: string[],
  type: GraphNode["type"] = "user",
  text = `text-${id}`
): GraphNode {
  const node: GraphNode = { id, type, parents, text, x: 100, y: 100, createdAt: ++clock };
  if (type !== "user") {
    node.cli = "claude";
    node.model = "sonnet";
  }
  return node;
}

function docOf(nodes: GraphNode[]): GraphDoc {
  return { id: "g1", name: "g", nodes, createdAt: 1, updatedAt: 1 };
}

// ----- compileContext: linear -----

test("root node compiles to the chat system prompt with an empty history", () => {
  const doc = docOf([n("q", [], "user", "hello")]);
  const c = compileContext(doc, "q");
  expect(c.merge).toBe(false);
  expect(c.prompt).toBe("hello");
  expect(c.system).toContain(GRAPH_CHAT_SYSTEM_PROMPT);
  expect(c.system).toContain("(none — this is the first exchange)");
});

test("single-parent lineage renders a labeled linear transcript in order", () => {
  const doc = docOf([
    n("u1", [], "user", "first question"),
    n("a1", ["u1"], "assistant", "first answer"),
    n("u2", ["a1"], "user", "follow-up")
  ]);
  const c = compileContext(doc, "u2");
  expect(c.merge).toBe(false);
  expect(c.prompt).toBe("follow-up");
  const iUser = c.system.indexOf("[user]\nfirst question");
  const iAssistant = c.system.indexOf("[assistant claude/sonnet]\nfirst answer");
  expect(iUser).toBeGreaterThan(-1);
  expect(iAssistant).toBeGreaterThan(iUser);
  // The inference node's own text lives in the prompt, not the history.
  expect(c.system).not.toContain("follow-up");
});

// ----- compileContext: merge (D3) -----

function mergedDoc(): { doc: GraphDoc; mergeId: string } {
  const nodes = [
    n("t1", [], "user", "trunk question"),
    n("t2", ["t1"], "assistant", "trunk answer"),
    n("a1", ["t2"], "user", "branch A question"),
    n("a2", ["a1"], "assistant", "branch A answer"),
    n("b1", ["t2"], "user", "branch B question"),
    n("b2", ["b1"], "assistant", "branch B answer"),
    n("m", ["a2", "b2"], "user", "now reconcile both")
  ];
  return { doc: docOf(nodes), mergeId: "m" };
}

test("multi-parent node uses the merge rendering: trunk once + labeled branches", () => {
  const { doc, mergeId } = mergedDoc();
  const c = compileContext(doc, mergeId);
  expect(c.merge).toBe(true);
  expect(c.system).toContain(GRAPH_MERGE_SYSTEM_PROMPT);
  expect(c.system).toContain("## Common trunk");
  expect(c.system).toContain("## Branch A");
  expect(c.system).toContain("## Branch B");
  // Trunk deduplicated: rendered exactly once (D3 / 3-way merge).
  expect(c.system.split("trunk answer").length - 1).toBe(1);
  expect(c.system).toContain("branch A answer");
  expect(c.system).toContain("branch B answer");
  // Sections are honest about divergence, not a fake linear chat.
  expect(GRAPH_MERGE_SYSTEM_PROMPT).toContain("do NOT know each other");
});

test("budget: an oversized branch is elided with an explicit marker (D8)", () => {
  const big = "x".repeat(15_000);
  const nodes: GraphNode[] = [n("u0", [], "user", "start")];
  let prev = "u0";
  for (let i = 1; i <= 12; i++) {
    const id = `h${i}`;
    nodes.push(n(id, [prev], i % 2 ? "assistant" : "user", `${big} #${i}`));
    prev = id;
  }
  nodes.push(n("q", [prev], "user", "final question"));
  const c = compileContext(docOf(nodes), "q");
  expect(c.system.length).toBeLessThan(GRAPH_MAX_CONTEXT_CHARS + 5000);
  expect(c.system).toContain("earlier exchanges elided");
  // The tail stays verbatim.
  expect(c.system).toContain("#12");
});

test("composeSinglePrompt appends the question for system-less CLIs (D5)", () => {
  const doc = docOf([n("q", [], "user", "THE-FINAL-QUESTION")]);
  const s = composeSinglePrompt(compileContext(doc, "q"));
  expect(s).toContain(GRAPH_CHAT_SYSTEM_PROMPT);
  expect(s.indexOf("THE-FINAL-QUESTION")).toBeGreaterThan(s.indexOf("## Operator's message"));
});

// ----- judge -----

test("buildJudgeSystem embeds context, prompt and anonymized answers", () => {
  const doc = docOf([n("q", [], "user", "pick a launch day")]);
  const s = buildJudgeSystem(compileContext(doc, "q"), [
    { label: "A", text: "Wednesday" },
    { label: "B", text: "Tuesday" }
  ]);
  expect(s).toContain(GRAPH_JUDGE_SYSTEM_PROMPT);
  expect(s).toContain("## Answer A\n\nWednesday");
  expect(s).toContain("## Answer B\n\nTuesday");
  expect(s).toContain("pick a launch day");
  // Anonymized: no model names on the judge's data side.
  expect(s).not.toContain("claude");
  expect(s).not.toContain("sonnet");
});

// ----- runInference (injected runner) -----

function deps(run: (cmd: string) => Promise<string>): {
  stateDir: string;
  shell: string;
  cwd: string;
  run: (cmd: string) => Promise<string>;
} {
  return { stateDir: tmp(), shell: "", cwd: "/", run };
}

test("fan-out: one assistant node per target, errors isolated per target", async () => {
  const doc = docOf([n("q", [], "user", "hello")]);
  const out = await runInference(
    deps(async (cmd) => {
      if (cmd.includes("codex")) throw new Error("codex not installed");
      return "an answer";
    }),
    doc,
    {
      nodeId: "q",
      targets: [
        { cli: "claude", model: "sonnet" },
        { cli: "codex", model: "" }
      ],
      battle: false
    }
  );
  const added = out.nodes.filter((x) => x.type === "assistant");
  expect(added).toHaveLength(2);
  const ok = added.find((x) => x.cli === "claude")!;
  const ko = added.find((x) => x.cli === "codex")!;
  expect(ok.status).toBe("ok");
  expect(ok.text).toBe("an answer");
  expect(ok.parents).toEqual(["q"]);
  expect(ok.durationMs).toBeGreaterThanOrEqual(0);
  expect(ko.status).toBe("error");
  expect(ko.error).toContain("codex not installed");
  // The input doc is not mutated.
  expect(doc.nodes).toHaveLength(1);
});

test("battle: judge node arbitrates the ok answers, legend reveals the mapping", async () => {
  const doc = docOf([n("q", [], "user", "hello")]);
  const out = await runInference(
    deps(async (cmd) => (cmd.includes(GRAPH_JUDGE_PROMPT.slice(0, 20)) ? "merged verdict" : "candidate")),
    doc,
    {
      nodeId: "q",
      targets: [
        { cli: "claude", model: "opus" },
        { cli: "gemini", model: "" }
      ],
      battle: true
    }
  );
  const judge = out.nodes.find((x) => x.type === "judge");
  expect(judge).toBeDefined();
  expect(judge!.status).toBe("ok");
  expect(judge!.text).toContain("merged verdict");
  expect(judge!.text).toContain("A = claude/opus");
  expect(judge!.text).toContain("B = gemini");
  expect(judge!.cli).toBe(DEFAULT_JUDGE.cli);
  const assistants = out.nodes.filter((x) => x.type === "assistant");
  expect(judge!.parents.sort()).toEqual(assistants.map((a) => a.id).sort());
});

test("battle degrades: a single ok answer gets no judge", async () => {
  const doc = docOf([n("q", [], "user", "hello")]);
  const out = await runInference(
    deps(async (cmd) => {
      if (cmd.includes("gemini")) throw new Error("down");
      return "only answer";
    }),
    doc,
    {
      nodeId: "q",
      targets: [
        { cli: "claude", model: "" },
        { cli: "gemini", model: "" }
      ],
      battle: true
    }
  );
  expect(out.nodes.find((x) => x.type === "judge")).toBeUndefined();
});

test("inference refuses non-user nodes and unknown nodes", async () => {
  const doc = docOf([n("q", [], "user"), n("a", ["q"], "assistant")]);
  const d = deps(async () => "x");
  await expect(
    runInference(d, doc, { nodeId: "a", targets: [{ cli: "claude", model: "" }], battle: false })
  ).rejects.toThrow("user node");
  await expect(
    runInference(d, doc, { nodeId: "ghost", targets: [{ cli: "claude", model: "" }], battle: false })
  ).rejects.toThrow("unknown node");
  await expect(runInference(d, doc, { nodeId: "q", targets: [], battle: false })).rejects.toThrow(
    "no inference target"
  );
});

// ----- local providers (C29) -----

test("a 'local' target routes over HTTP with the provider's endpoint", async () => {
  const doc = docOf([n("q", [], "user", "hello")]);
  const httpCalls: unknown[] = [];
  const out = await runInference(
    {
      ...deps(async () => "cli answer"),
      localProviders: [{ id: "oll", name: "Ollama", baseUrl: "http://h", apiKey: "k" }],
      http: async (input) => {
        httpCalls.push(input);
        return "local answer";
      }
    },
    doc,
    {
      nodeId: "q",
      targets: [
        { cli: "claude", model: "sonnet" },
        { cli: "local", model: "qwen3:32b", providerId: "oll" }
      ],
      battle: false
    }
  );
  const local = out.nodes.find((x) => x.cli === "local")!;
  expect(local.status).toBe("ok");
  expect(local.text).toBe("local answer");
  expect(local.providerId).toBe("oll");
  expect(httpCalls).toHaveLength(1);
  const call = httpCalls[0] as { baseUrl: string; apiKey?: string; model: string; system: string };
  expect(call.baseUrl).toBe("http://h");
  expect(call.apiKey).toBe("k");
  expect(call.model).toBe("qwen3:32b");
  expect(call.system).toContain("GRAPH CHAT");
});

test("a 'local' target with an unknown provider yields an error node", async () => {
  const doc = docOf([n("q", [], "user", "hello")]);
  const out = await runInference(
    { ...deps(async () => "x"), localProviders: [] },
    doc,
    { nodeId: "q", targets: [{ cli: "local", model: "m", providerId: "ghost" }], battle: false }
  );
  const node = out.nodes.find((x) => x.type === "assistant")!;
  expect(node.status).toBe("error");
  expect(node.error).toContain("unknown local provider");
});
