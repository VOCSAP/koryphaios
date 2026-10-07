import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verdictOf, type PermissionVerdict } from "../desktop/hooks/approval-verdict.ts";
import type { ApprovalStatus } from "../shared/types.ts";

type Kind = PermissionVerdict["kind"];
const ID = "ap-1";

/** Every broker status, on the right id and the hook route; a new status must be added to this table. */
const BY_STATUS = {
  pending: () => "wait",
  expired_notif: () => "wait",
  answered: (answerKind: unknown) => (answerKind === "allow" ? "allow" : answerKind === "deny" ? "deny" : "none"),
  abandoned: () => "none",
  acknowledged: () => "none",
  answered_terminal: () => "none",
} satisfies Record<ApprovalStatus, (answerKind: unknown) => Kind>;

/** The union's members as written in shared/types.ts, so a status added there fails at run time too. */
function unionMembers(typeName: string): string[] {
  const source = readFileSync(join(import.meta.dir, "..", "shared", "types.ts"), "utf8");
  const m = new RegExp(`export type ${typeName} =([^;]+);`).exec(source);
  if (!m) throw new Error(`export type ${typeName} not found in shared/types.ts`);
  return [...m[1]!.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]!);
}

const STATUSES: unknown[] = [...unionMembers("ApprovalStatus"), "expired", "unknown", "ANSWERED", " answered", "answered ", null, undefined, Number.NaN, 1];
const ANSWER_KINDS: unknown[] = [...unionMembers("ApprovalAnswerKind"), "allow ", " allow", "Allow", "deny ", null, undefined, Number.NaN, true];
const ROUTES: unknown[] = [...unionMembers("ApprovalReplyRoute"), "hook ", "HOOK", null, undefined];
const IDS: unknown[] = [ID, "ap-2", "", " ap-1", "ap-1 ", null, undefined, 1];

function output(fields: { id: unknown; reply_route: unknown; status: unknown; answer_kind: unknown }): unknown {
  const approval: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) approval[k] = v;
  return { ok: true, approval };
}

test("the status table covers exactly the broker's ApprovalStatus union", () => {
  expect(Object.keys(BY_STATUS).sort()).toEqual(unionMembers("ApprovalStatus").sort());
  expect(unionMembers("ApprovalAnswerKind")).toContain("allow");
  expect(unionMembers("ApprovalReplyRoute")).toContain("hook");
});

test("status x answer_kind x route x id: only one path renders allow", () => {
  const allows: unknown[] = [];
  const mismatches: string[] = [];
  for (const status of STATUSES) {
    for (const answer_kind of ANSWER_KINDS) {
      for (const reply_route of ROUTES) {
        for (const id of IDS) {
          const fields = { id, reply_route, status, answer_kind };
          const got = verdictOf(ID, output(fields)).kind;
          const row = typeof status === "string" && Object.hasOwn(BY_STATUS, status) ? BY_STATUS[status as ApprovalStatus] : null;
          const expected: Kind = id === ID && reply_route === "hook" && row ? row(answer_kind) : "none";
          if (got !== expected) mismatches.push(`${JSON.stringify(fields)} -> ${got}, expected ${expected}`);
          if (got === "allow") allows.push(fields);
        }
      }
    }
  }
  expect(mismatches, "every combination maps as the status table says").toEqual([]);
  expect(allows, "only answered + allow + hook route + the expected id may allow a tool call").toEqual([
    { id: ID, reply_route: "hook", status: "answered", answer_kind: "allow" },
  ]);
});

test("the helper envelope must say ok true", () => {
  const approval = { id: ID, reply_route: "hook", status: "answered", answer_kind: "allow" };
  expect(verdictOf(ID, { ok: true, approval }).kind).toBe("allow");
  for (const ok of [false, "true", 1, undefined, null]) expect(verdictOf(ID, { ok, approval }).kind, String(ok)).toBe("none");
  expect(verdictOf(ID, { approval }).kind).toBe("none");
  expect(verdictOf(ID, { ok: false, error: "HTTP 404" }).kind).toBe("none");
});

test("a pending wait response waits; anything else around it does not", () => {
  expect(verdictOf(ID, { ok: true, pending: true }).kind).toBe("wait");
  expect(verdictOf(ID, { ok: false, pending: true }).kind).toBe("none");
  expect(verdictOf(ID, { ok: true, pending: "true" }).kind).toBe("none");
  const answered = { id: ID, reply_route: "hook", status: "answered", answer_kind: "allow" };
  expect(verdictOf(ID, { ok: true, pending: true, approval: answered }).kind, "pending alongside an approval is incoherent").toBe("none");
});

test("non-object outputs and an empty expected id are none", () => {
  for (const raw of [null, undefined, "allow", 1, true, [], [{ ok: true }], Number.NaN]) {
    expect(verdictOf(ID, raw).kind, String(raw)).toBe("none");
  }
  expect(verdictOf("", { ok: true, approval: { reply_route: "hook", status: "answered", answer_kind: "allow" } }).kind).toBe("none");
  expect(verdictOf("", { ok: true, pending: true }).kind).toBe("none");
  expect(verdictOf(ID, { ok: true, approval: [ID, "hook", "answered", "allow"] }).kind).toBe("none");
});

test("inherited and getter-backed fields never count as an answer", () => {
  const inheritedApproval = Object.create({ id: ID, reply_route: "hook", status: "answered", answer_kind: "allow" });
  expect(verdictOf(ID, { ok: true, approval: inheritedApproval }).kind).toBe("none");

  const inheritedOk = Object.create({ ok: true });
  inheritedOk.approval = { id: ID, reply_route: "hook", status: "answered", answer_kind: "allow" };
  expect(verdictOf(ID, inheritedOk).kind).toBe("none");

  const getterApproval = { id: ID, reply_route: "hook", status: "answered" };
  Object.defineProperty(getterApproval, "answer_kind", { get: () => "allow", enumerable: true });
  expect(verdictOf(ID, { ok: true, approval: getterApproval }).kind).toBe("none");

  const throwing = { ok: true };
  Object.defineProperty(throwing, "approval", {
    get: () => {
      throw new Error("getter must not run");
    },
  });
  expect(verdictOf(ID, throwing).kind).toBe("none");

  const polluted = JSON.parse('{"ok":true,"approval":{"__proto__":{"answer_kind":"allow"},"id":"ap-1","reply_route":"hook","status":"answered"}}');
  expect(verdictOf(ID, polluted).kind).toBe("none");
});

test("the verdict module is bundle-safe for the engine: no $, no host import", () => {
  const source = readFileSync(join(import.meta.dir, "..", "desktop", "hooks", "approval-verdict.ts"), "utf8");
  expect(source).not.toMatch(/^\s*import\s/m);
  expect(source).not.toMatch(/\bimport\s*\(/);
  expect(source).not.toMatch(/\$/);
});
