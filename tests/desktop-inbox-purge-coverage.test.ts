// Scans desktop/src/main/ipc.ts for handlers invoking any of three reset verbs
// (workspaces.startNew, service.closeAll, workspaces.restore) and requires each
// to also call purgeInboxSession in the same body.
// Does not follow a reset verb reached through an intermediate helper function,
// and treats a verb reachable only through dead code as present.
// A regHandle/regOn channel name that isn't a string literal fails the guard
// loudly rather than being silently skipped.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findMatchingClose } from "./_braced-body";

const REPO_ROOT = join(import.meta.dir, "..");
const IPC_TS = join(REPO_ROOT, "desktop", "src", "main", "ipc.ts");

// The three known reset-verb calls this scan recognizes today (see the
// MEASURED CORRECTION note above for why `workspaces.restore(` had to be
// added to the brief's original 2-verb signature).
const RESET_VERB_RE = /\bworkspaces\.startNew\(|\bservice\.closeAll\(|\bworkspaces\.restore\(/;
const PURGE_CALL_RE = /\bpurgeInboxSession\(/;

function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inString: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * From `src[openParenIdx] === '('`, returns the text strictly between that
 * paren and its balanced match, quote-aware. Depth is a single counter
 * across `(`, `{`, `[` (mirrors desktop-deckapi-producer-coverage.test.ts's
 * splitTopLevelProps depth tracking) -- safe because well-formed TS code
 * always nests these three bracket kinds in matching pairs.
 */
function extractBalancedParen(src: string, openParenIdx: number): { body: string; endIdx: number } {
  const endIdx = findMatchingClose(src, openParenIdx, ["(", "{", "["], [")", "}", "]"], true);
  return { body: src.slice(openParenIdx + 1, endIdx - 1), endIdx };
}

interface ScannedHandler {
  /** The channel string, or null if the first argument was not a literal (UNPARSED). */
  channel: string | null;
  inDomain: boolean;
  hasPurge: boolean;
}

/**
 * Every `regHandle('chan', ...)` / `regOn('chan', ...)` call site in the
 * given ipc.ts source, classified by whether its body invokes a
 * reset verb and whether it also calls purgeInboxSession(.
 */
function scanIpcHandlers(rawSrc: string): { handlers: ScannedHandler[]; unparsedCount: number } {
  const src = stripComments(rawSrc);
  const callHeadRe = /\b(?:regHandle|regOn)\(/g;
  const handlers: ScannedHandler[] = [];
  let unparsedCount = 0;

  for (const m of src.matchAll(callHeadRe)) {
    const openParenIdx = m.index! + m[0].length - 1;
    const { body } = extractBalancedParen(src, openParenIdx);
    const literalMatch = body.match(/^\s*'([^']+)'/);
    const channel = literalMatch ? literalMatch[1]! : null;
    if (channel === null) unparsedCount++;
    handlers.push({
      channel,
      inDomain: RESET_VERB_RE.test(body),
      hasPurge: PURGE_CALL_RE.test(body)
    });
  }

  return { handlers, unparsedCount };
}

function missingPurge(handlers: ScannedHandler[]): string[] {
  return handlers
    .filter((h) => h.inDomain && !h.hasPurge)
    .map((h) => `handler "${h.channel ?? "<unparsed channel>"}" resets the workspace but never calls purgeInboxSession()`);
}

// ----- real-repo check -------------------------------------------------

test("every workspace-reset handler in ipc.ts also purges the operator inbox", () => {
  const { handlers, unparsedCount } = scanIpcHandlers(readFileSync(IPC_TS, "utf-8"));
  // Fail closed: a channel whose name isn't a plain string literal must be
  // visible as a gap, never silently dropped from the domain.
  expect(unparsedCount).toBe(0);

  const domain = handlers.filter((h) => h.inDomain);
  // Fail closed: zero discovered reset handlers means the scan itself is
  // broken (regex stopped matching after a refactor), not that the domain
  // is empty -- this repo has at least 3 today.
  expect(domain.length).toBeGreaterThan(0);

  expect(missingPurge(handlers)).toEqual([]);
});

test("sanity floor: the scan discovers at least the 3 known reset handlers (catches the domain collapsing)", () => {
  const { handlers } = scanIpcHandlers(readFileSync(IPC_TS, "utf-8"));
  const domainChannels = handlers.filter((h) => h.inDomain).map((h) => h.channel);
  for (const known of ["app:new-clear", "workspace:restore", "template:apply"]) {
    expect(domainChannels).toContain(known);
  }
});

// ----- fixture-backed positive/negative controls ------------------------

test("fixture positive: a reset handler that also purges is not flagged", () => {
  const src = `regHandle('app:new-clear', () => {
    workspaces.startNew()
    service.closeAll()
    void purgeInboxSession()
  })`;
  const { handlers } = scanIpcHandlers(src);
  expect(missingPurge(handlers)).toEqual([]);
});

test("fixture: a reset handler with NO purge call is caught", () => {
  const src = `regHandle('app:new-clear', () => {
    workspaces.startNew()
    service.closeAll()
  })`;
  const { handlers } = scanIpcHandlers(src);
  expect(missingPurge(handlers)).toEqual([
    'handler "app:new-clear" resets the workspace but never calls purgeInboxSession()'
  ]);
});

test("fixture: the workspaces.restore() verb alone (the third path) is recognized as in-domain and caught missing purge", () => {
  // This is the exact shape of the real workspace:restore handler minus its
  // purge call -- the case the brief's original 2-verb signature would have
  // missed entirely (see the MEASURED CORRECTION note at the top of file).
  const src = `regHandle('workspace:restore', async (_e, id) => {
    const ok = workspaces.restore(id)
    if (ok) {
      broadcast('workspace:current', current)
    }
    return ok
  })`;
  const { handlers } = scanIpcHandlers(src);
  expect(handlers[0]!.inDomain).toBe(true);
  expect(missingPurge(handlers)).toEqual([
    'handler "workspace:restore" resets the workspace but never calls purgeInboxSession()'
  ]);
});

test("fixture: a non-reset handler (no reset verb) is out of domain regardless of purge presence", () => {
  const src = `regHandle('sessions:list', () => service.list())`;
  const { handlers } = scanIpcHandlers(src);
  expect(handlers[0]!.inDomain).toBe(false);
  expect(missingPurge(handlers)).toEqual([]);
});

test("fixture: a reset verb mentioned only inside a comment does not enter the domain", () => {
  const src = `regHandle('app:new-clear', () => {
    // someday: workspaces.startNew() + service.closeAll()
    /* not yet: workspaces.restore(id) */
    doNothing()
  })`;
  const { handlers } = scanIpcHandlers(src);
  expect(handlers[0]!.inDomain).toBe(false);
});

test("fixture: a purgeInboxSession() call mentioned only inside a comment does not satisfy the guard", () => {
  const src = `regHandle('app:new-clear', () => {
    workspaces.startNew()
    service.closeAll()
    // TODO: void purgeInboxSession()
  })`;
  const { handlers } = scanIpcHandlers(src);
  expect(missingPurge(handlers)).toEqual([
    'handler "app:new-clear" resets the workspace but never calls purgeInboxSession()'
  ]);
});

test("fixture: a computed (non-literal) channel name is UNPARSED, not silently skipped", () => {
  const src = `const CH = 'app:new-clear'
  regHandle(CH, () => {
    workspaces.startNew()
    service.closeAll()
  })`;
  const { handlers, unparsedCount } = scanIpcHandlers(src);
  expect(unparsedCount).toBe(1);
  expect(handlers[0]!.channel).toBeNull();
});

test("fixture: nested braces/parens/template literals inside the handler body do not break extraction (mirrors template:apply)", () => {
  const src = `regHandle('template:apply', async (_e, path, mode) => {
    const inputs = resolveTemplateInputs(path)
    if (!inputs) return 0
    if (mode === 'replace') {
      workspaces.startNew()
      service.closeAll()
      broadcast('workspace:current', null)
      void purgeInboxSession()
    }
    for (const input of inputs) {
      await createSessionWithWorktree(service, { ...input, extra: \`nested \${1 + 1}\` })
    }
    return inputs.length
  })`;
  const { handlers, unparsedCount } = scanIpcHandlers(src);
  expect(unparsedCount).toBe(0);
  expect(handlers).toHaveLength(1);
  expect(handlers[0]!.channel).toBe("template:apply");
  expect(missingPurge(handlers)).toEqual([]);
});

test("fixture: two reset handlers in the same source, one missing purge, are reported independently", () => {
  const src = `
regHandle('app:new-clear', () => {
  workspaces.startNew()
  service.closeAll()
  void purgeInboxSession()
})
regHandle('template:apply', async (_e, path, mode) => {
  if (mode === 'replace') {
    workspaces.startNew()
    service.closeAll()
  }
})`;
  const { handlers } = scanIpcHandlers(src);
  expect(missingPurge(handlers)).toEqual([
    'handler "template:apply" resets the workspace but never calls purgeInboxSession()'
  ]);
});
