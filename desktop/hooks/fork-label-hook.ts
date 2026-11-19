import { buildForkLabelOutput } from "./run-anchor.ts";

async function drainStdin(): Promise<void> {
  for await (const _chunk of process.stdin) void _chunk;
}

if (import.meta.main) {
  process.stdout.write(buildForkLabelOutput(process.env.KORY_FORKED_FROM || ""));
  void drainStdin().finally(() => process.exit(0));
}
