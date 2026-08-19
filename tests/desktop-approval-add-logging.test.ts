// Card 55c5470e: handleApprovalAdd (broker.ts) logged its DUPLICATE-raise
// branch but never its ordinary, successful, NEW-insert path -- which is
// exactly what made two reported occurrences of an unattributed blocking
// question ("Claude is waiting for your input", sender "?") untraceable by
// timestamp in broker.log. This proves the nominal path now leaves a trace
// too, and that the duplicate path still logs its own (different) message
// exactly once, never both.
//
// broker.ts cannot be imported directly under bun: it calls Bun.serve(...)
// unconditionally at module scope (no `import.meta.main` guard), so any file
// that imports it becomes -- by TESTING.md's own rule (`0. Does your file
// run there at all?`) -- a daemon-spawning integration suite that belongs in
// the `broker-*` family EXCLUDED from the cross-platform CI glob. Team-lead
// ruling 2026-08-17 (card 55c5470e): this fix must stay verifiable under the
// `desktop-*` prefix, so it must not import broker.ts.
//
// Technique: identical to tests/desktop-approval-defer.test.ts's `slice()` --
// cut the REAL function verbatim out of the CURRENT broker.ts (re-read on
// every run, not a frozen copy) by anchor + first column-0 terminator, eval
// it with a handful of fakes for its free variables, and assert on what it
// actually calls. Anti-drift property (measured, not assumed -- team-lead
// asked for this explicitly): if broker.ts ever renames/moves this function,
// `slice()` throws "anchor not found" at test-collection time; if a future
// edit adds a free variable this env object does not provide, the eval
// throws a ReferenceError at call time. Either way this test fails LOUDLY
// rather than silently passing against stale bytes -- it can only stay green
// while exercising broker.ts's CURRENT handleApprovalAdd, verbatim. The one
// gap this cannot catch: a behavior change that keeps the same anchor, the
// same free variables, AND produces the same log calls my assertions check
// for. That residual is accepted, matching the existing precedent.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { validateApprovalDraft, generateCredential, deriveOperatorId, buildAuthProof } from "../shared/approval.ts";
import {
  createApprovalAuth,
  approvalWhere as sliceApprovalWhere,
  stampInsert as sliceStampInsert,
  isAuthError as sliceIsAuthError,
} from "../shared/approval-scope.ts";

/**
 * Card 1def56da. The slice authorises through shared/approval-scope.ts now, so
 * the injected scope has to provide that surface.
 *
 * A REAL auth over a fake database, not a fabricated scope object: an
 * `ApprovalScope` is opaque and its fields live in a WeakMap keyed on object
 * identity, so a hand-made one is refused at runtime -- which is the guarantee
 * the card exists for. Faking it here would have meant either weakening that
 * guarantee or testing something the broker never runs.
 */
function sliceAuth(): ReturnType<typeof createApprovalAuth> {
  const op = generateCredential();
  const operatorId = deriveOperatorId(op.publicKey);
  const real = createApprovalAuth({
    queryOne: <T,>(): T => ({ public_key: op.publicKey }) as T,
    queryAll: <T,>(): T[] => [],
    run: (): void => {},
    rememberNonce: (): boolean => true,
  });
  // The slice calls `authorizeCreate(body)` with the test's own draft body,
  // which carries no credential. Wrap it so the signature and the mandatory
  // project declaration are supplied here rather than by every draftBody().
  return {
    ...real,
    authorizeCreate: (body: Record<string, unknown>) => {
      const signedBody = { ...body, project_key: "p", public_key: op.publicKey };
      const auth = buildAuthProof(op.privateKey, signedBody, {
        kind: "operator",
        operator_id: operatorId,
      });
      return real.authorizeCreate({ ...signedBody, auth });
    },
  } as ReturnType<typeof createApprovalAuth>;
}

const BROKER = process.env.KORY_BROKER_TS || join(import.meta.dir, "..", "broker.ts");
// broker.ts is CRLF on disk (same note as desktop-approval-defer.test.ts);
// normalise line endings only, so a \n-based indexOf finds the anchors.
const SRC = readFileSync(BROKER, "utf8").replace(/\r\n/g, "\n");
const SCRATCH = mkdtempSync(join(tmpdir(), "kory-broker-slice-"));

function slice(anchor: string, terminators: string[], label: string): string {
  const start = SRC.indexOf(anchor);
  if (start < 0) throw new Error(`${label}: anchor not found -- broker.ts changed shape`);
  const ends = terminators
    .map((t) => ({ t, i: SRC.indexOf(t, start) }))
    .filter((c) => c.i >= 0)
    .sort((a, b) => a.i - b.i);
  if (ends.length === 0) throw new Error(`${label}: no column-0 terminator after the anchor`);
  const body = SRC.slice(start, ends[0].i + ends[0].t.length - 1);
  const lineOf = (idx: number) => SRC.slice(0, idx).split("\n").length;
  console.log(
    `[${label}] broker.ts lines ${lineOf(start)}..${lineOf(ends[0].i)} ` +
      `(${body.length} bytes, sha256 ${createHash("sha256").update(body).digest("hex").slice(0, 16)})`,
  );
  return body;
}

async function evaluate<T>(wrapper: string, name: string): Promise<(env: Record<string, unknown>) => T> {
  const file = join(SCRATCH, `${name}-${createHash("sha256").update(wrapper).digest("hex").slice(0, 8)}.ts`);
  writeFileSync(file, wrapper);
  const mod = (await import(pathToFileURL(file).href)) as { register: (env: Record<string, unknown>) => T };
  return mod.register;
}

const HANDLE_APPROVAL_ADD = slice("function handleApprovalAdd(", ["\n}\n"], "handleApprovalAdd");

const registerHandleApprovalAdd = await evaluate<{
  handleApprovalAdd: (body: Record<string, unknown>) => unknown;
}>(
  // Card 1def56da: `resolveApprovalAuth` is gone from this destructuring
  // because it is gone from broker.ts. The five names that replace it are the
  // authorization surface the sliced body now closes over. If a future edit
  // adds another free variable, the eval throws a ReferenceError at call time
  // and this suite fails LOUDLY -- which is exactly how the refactor was
  // caught, and the property the file's header promises.
  `export function register(env) {
  const { approvalAuth, approvalWhere, stampInsert, assertStampSessionRef, isAuthError,
          validateApprovalDraft, db, rowToApproval, APPROVAL_MAX_PENDING,
          resolveReplyRoute, APPROVAL_NOTIF_TTL_HOURS, randomUUID, notifyRegistry, log } = env
${HANDLE_APPROVAL_ADD}
  return { handleApprovalAdd }
}
`,
  "handleApprovalAdd",
);

interface LogCall {
  level: "info" | "error";
  message: string;
}

/** `existingRow` non-null simulates a pending duplicate for the same tile. */
function makeDb(existingRow: unknown) {
  const queries: string[] = [];
  // Card 1def56da. Two things changed in the sliced body and both land here.
  // The de-duplication SELECT no longer spells its identity clause inline (it
  // interpolates `${where.sql}`), so it is recognised by `tile_ref = ?`; and
  // the handler now READS THE ROW BACK after inserting, instead of assembling
  // its response from values it holds. The read-back therefore has to return
  // something, or the handler takes its "vanished between insert and read-back"
  // branch and logs an error rather than the nominal line under test.
  let inserted: Record<string, unknown> | null = null;
  return {
    query(sql: string) {
      queries.push(sql);
      return {
        get(...params: unknown[]) {
          if (sql.includes("SELECT COUNT(*) AS n")) return { n: 0 };
          if (sql.includes("tile_ref = ?") && sql.includes("status = 'pending'")) return existingRow;
          // The read-back. `rowToApproval` is the identity in this harness, so
          // the shape returned is what the log line reads: kind, id, and the
          // tile_ref that must render as `tile=-` when empty.
          if (sql.includes("WHERE id = ?")) {
            return inserted ? { ...inserted, id: params[0] } : null;
          }
          return null;
        },
      };
    },
    run(_sql: string, values: unknown[]) {
      // Mirror just enough of the INSERT for the read-back above. The column
      // order is the handler's own: id, then the three stamp columns, then
      // origin_host / origin_user / group_id / from_peer, then tile_ref.
      inserted = {
        id: values[0],
        kind: "question",
        origin: { tile_ref: values[8] ?? "" },
      };
    },
    queries,
  };
}

function env(overrides: { existingRow?: unknown } = {}) {
  const calls: LogCall[] = [];
  const db = makeDb(overrides.existingRow ?? null);
  return {
    env: {
      // Card 1def56da. `resolveApprovalAuth` USED TO BE STUBBED HERE and no
      // longer exists: the sliced function now authorises through
      // shared/approval-scope.ts, so the slice needs that surface instead.
      //
      // This suite executes the body of `handleApprovalAdd` VERBATIM in an
      // injected scope, which is exactly why it broke on a refactor that
      // changed no behaviour it asserts: it depends on the function's internal
      // vocabulary, not on its contract. The contract IS preserved and is what
      // the tests below still check, unchanged -- one 'approval: new' line on
      // the nominal path, `tile=-` for an empty tile_ref, and no nominal line
      // on a duplicate raise.
      //
      // The stubs return real opaque values by building a genuine auth against
      // a fake db, rather than fabricating a scope object: a hand-made one is
      // refused at runtime by the WeakMap, which is the guarantee itself.
      approvalAuth: sliceAuth(),
      approvalWhere: sliceApprovalWhere,
      stampInsert: sliceStampInsert,
      assertStampSessionRef: () => null,
      isAuthError: sliceIsAuthError,
      validateApprovalDraft,
      db,
      rowToApproval: (row: unknown) => row,
      APPROVAL_MAX_PENDING: 50,
      resolveReplyRoute: () => ({ route: "pty" as const, token: "", group: "" }),
      APPROVAL_NOTIF_TTL_HOURS: 24,
      randomUUID,
      notifyRegistry: { fanOut: async () => {} },
      log: {
        info: (msg: string) => calls.push({ level: "info", message: msg }),
        error: (msg: string) => calls.push({ level: "error", message: msg }),
      },
    },
    calls,
  };
}

function draftBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: "question",
    title: "t",
    question: "q",
    tile_ref: "tile-42",
    ...overrides,
  };
}

describe("handleApprovalAdd (broker.ts, sliced verbatim) -- nominal-path logging", () => {
  test("RED PROOF -- a fresh, non-duplicate add logs an 'approval: new' line naming kind/id/tile", async () => {
    const { env: e, calls } = env();
    const { handleApprovalAdd } = registerHandleApprovalAdd(e);
    const result = handleApprovalAdd(draftBody()) as { approval: { id: string } };

    const nominal = calls.filter((c) => c.message.startsWith("approval: new "));
    expect(nominal.length).toBe(1);
    expect(nominal[0]!.level).toBe("info");
    expect(nominal[0]!.message).toContain("question");
    expect(nominal[0]!.message).toContain(result.approval.id);
    expect(nominal[0]!.message).toContain("tile=tile-42");
  });

  test("an empty tile_ref renders as 'tile=-', never a blank/undefined-looking segment", async () => {
    const { env: e, calls } = env();
    const { handleApprovalAdd } = registerHandleApprovalAdd(e);
    handleApprovalAdd(draftBody({ tile_ref: "" }));

    const nominal = calls.find((c) => c.message.startsWith("approval: new "));
    expect(nominal?.message).toContain("tile=-");
  });

  test("a duplicate raise logs ONLY its own message, never the nominal 'approval: new' one", async () => {
    const { env: e, calls } = env({ existingRow: { id: "existing-id" } });
    const { handleApprovalAdd } = registerHandleApprovalAdd(e);
    const result = handleApprovalAdd(draftBody()) as { approval: unknown };

    expect(result.approval).toEqual({ id: "existing-id" });
    expect(calls.length).toBe(1);
    expect(calls[0]!.message).toContain("duplicate raise");
    expect(calls.some((c) => c.message.startsWith("approval: new "))).toBe(false);
  });
});
