// Stands in for the hook's evaluation worker dying mid-evaluation: it decides
// one rule, then crashes.
import { parentPort } from "node:worker_threads";

parentPort.postMessage({ type: "decided", qualifiedId: "user/decided-pass", match: null });
setTimeout(() => {
  throw new Error("simulated evaluation worker crash");
}, 50);
