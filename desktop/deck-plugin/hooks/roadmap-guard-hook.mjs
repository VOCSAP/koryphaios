import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// hooks/roadmap-guard-hook.ts
var TOOL_TEXT_FIELDS = {
  "mcp__claude-peers__roadmap_add": ["title", "description", "rationale", "context"],
  "mcp__claude-peers__roadmap_update": ["title", "description", "rationale", "context"],
  "mcp__claude-peers__roadmap_append_context": ["text"]
};
function detectSerializationAccident(toolName, toolInput) {
  const fields = TOOL_TEXT_FIELDS[toolName];
  if (!fields || !toolInput)
    return null;
  for (const field of fields) {
    const value = toolInput[field];
    if (typeof value !== "string" || value === "")
      continue;
    const closeThenOpenRe = new RegExp(`</${field}>\\s*<parameter\\s+name\\s*=\\s*"([a-zA-Z0-9_]+)"\\s*>`);
    const match = closeThenOpenRe.exec(value);
    if (match) {
      return { field, targetField: match[1], matchedTag: match[0] };
    }
  }
  return null;
}
function buildRefusalReason(m) {
  return [
    `roadmap-guard: field "${m.field}" contains ${m.matchedTag}, right where "${m.field}" itself should have ended.`,
    `That is this field's own closing tag followed by another parameter's opening tag -- content for two parameters landed in one.`,
    `If this is accidental: split the content of "${m.field}" back into the parameters it was meant for, and resend.`,
    `If you are quoting this markup on purpose: break the closing tag itself, e.g. write "< /${m.field}>" with a space, then resend.`
  ].join(" ");
}
function parseHookPayload(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function buildDecision(payload) {
  if (payload.hook_event_name !== "PreToolUse")
    return null;
  const toolName = payload.tool_name ?? "";
  if (!Object.hasOwn(TOOL_TEXT_FIELDS, toolName))
    return null;
  const m = detectSerializationAccident(toolName, payload.tool_input);
  if (!m)
    return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: buildRefusalReason(m)
    }
  };
}
async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin)
    raw += chunk;
  return raw;
}
async function main() {
  const payload = parseHookPayload(await readStdin());
  const decision = buildDecision(payload);
  if (decision)
    process.stdout.write(JSON.stringify(decision));
}
if (__require.main == __require.module) {
  main().catch(() => {}).finally(() => process.exit(0));
}
export {
  parseHookPayload,
  detectSerializationAccident,
  buildRefusalReason,
  buildDecision
};
