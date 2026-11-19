const UUID_SHAPE = /^[0-9a-f-]{36}$/;

// The line is the whole additionalContext: hypomnema matches it as an exact line,
// so nothing else may share the output.
function sessionStartOutput(line: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: line } });
}

/** Empty when the id is not a UUID-shaped value: an anchor with a blank or forged id must never reach the model. */
export function buildRunAnchorOutput(runAnchorId: string): string {
  return UUID_SHAPE.test(runAnchorId) ? sessionStartOutput(`<<anchor session Kory id=${runAnchorId} /anchor>>`) : "";
}

/** Empty when the id is not a UUID-shaped value. The caller only runs it on a `fork` SessionStart. */
export function buildForkLabelOutput(prevSessionId: string): string {
  return UUID_SHAPE.test(prevSessionId) ? sessionStartOutput(`<<label forked_from=${prevSessionId} /label>>`) : "";
}
