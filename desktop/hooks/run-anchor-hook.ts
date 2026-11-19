import { buildRunAnchorOutput } from "./run-anchor.ts";

async function drainStdin(): Promise<void> {
  for await (const _chunk of process.stdin) void _chunk;
}

if (import.meta.main) {
  process.stdout.write(buildRunAnchorOutput(process.env.KORY_RUN_ANCHOR_ID || ""));
  void drainStdin().finally(() => process.exit(0));
}
