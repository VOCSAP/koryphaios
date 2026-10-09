// Stands in for an evaluation that threw inside the worker and reported it.
import { parentPort } from "node:worker_threads";

parentPort.postMessage({ type: "failed", error: "simulated evaluation exception" });
