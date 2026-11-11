import { expect, test } from "bun:test";
import { TileTelemetryPublisher, type TileTelemetryDraft } from "../desktop/src/main/peer-telemetry-publisher.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

const firstSnapshot = {
  model: "Opus",
  modelId: "claude-opus-4",
  contextPct: 48,
  contextWindow: 200000,
  observedAt: 1000
};

test("publisher uses the source observation and limits a tile to one request in flight", async () => {
  const first = deferred();
  const sent: TileTelemetryDraft[] = [];
  const publisher = new TileTelemetryPublisher({
    send: (draft) => {
      sent.push(draft);
      return first.promise;
    },
    report: () => {}
  });

  publisher.start("tile", "a".repeat(64));
  publisher.publish("tile", firstSnapshot);
  publisher.publish("tile", { ...firstSnapshot, observedAt: 2000 });

  expect(sent).toEqual([{ deskSession: "tile", launchHash: "a".repeat(64), action: "publish", snapshot: firstSnapshot }]);
  first.resolve();
  await Promise.resolve();
});

test("a superseded launch completes its own stop without changing the new launch", async () => {
  const first = deferred();
  const sent: TileTelemetryDraft[] = [];
  const publisher = new TileTelemetryPublisher({
    send: (draft) => {
      sent.push(draft);
      return sent.length === 1 ? first.promise : Promise.resolve();
    },
    report: () => {}
  });

  publisher.start("tile", "a".repeat(64));
  publisher.publish("tile", firstSnapshot);
  const stopping = publisher.stop("tile");
  publisher.start("tile", "b".repeat(64));
  publisher.publish("tile", { ...firstSnapshot, observedAt: 2000 });

  expect(sent).toHaveLength(1);
  first.resolve();
  await stopping;
  publisher.publish("tile", { ...firstSnapshot, observedAt: 3000 });
  expect(sent).toEqual([
    { deskSession: "tile", launchHash: "a".repeat(64), action: "publish", snapshot: firstSnapshot },
    { deskSession: "tile", launchHash: "a".repeat(64), action: "stop" },
    { deskSession: "tile", launchHash: "b".repeat(64), action: "publish", snapshot: { ...firstSnapshot, observedAt: 3000 } }
  ]);
});

test("a publication failure is reported and the next poll may publish the current observation", async () => {
  const sent: TileTelemetryDraft[] = [];
  const reports: string[] = [];
  const publisher = new TileTelemetryPublisher({
    send: (draft) => {
      sent.push(draft);
      return sent.length === 1 ? Promise.reject(new Error("offline")) : Promise.resolve();
    },
    report: (message) => reports.push(message)
  });

  publisher.start("tile", "a".repeat(64));
  publisher.publish("tile", firstSnapshot);
  await Promise.resolve();
  await Promise.resolve();
  publisher.publish("tile", firstSnapshot);

  expect(reports).toEqual(["tile telemetry publish failed for tile"]);
  expect(sent).toHaveLength(2);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

test("a persistent publication failure leaves one report, and a failure after a recovery leaves a second", async () => {
  const outcomes = ["fail", "fail", "fail", "ok", "fail", "fail"];
  const reports: string[] = [];
  const publisher = new TileTelemetryPublisher({
    send: () => (outcomes.shift() === "ok" ? Promise.resolve() : Promise.reject(new Error("offline"))),
    report: (message) => reports.push(message)
  });

  publisher.start("tile", "a".repeat(64));
  for (let i = 0; i < 3; i++) {
    publisher.publish("tile", firstSnapshot);
    await settle();
  }
  expect(reports).toHaveLength(1);

  publisher.publish("tile", firstSnapshot);
  await settle();
  expect(reports).toHaveLength(1);

  for (let i = 0; i < 2; i++) {
    publisher.publish("tile", firstSnapshot);
    await settle();
  }
  expect(reports).toHaveLength(2);
});

test("a stop failure is reported even after a publication failure was", async () => {
  const reports: string[] = [];
  const publisher = new TileTelemetryPublisher({
    send: () => Promise.reject(new Error("offline")),
    report: (message) => reports.push(message)
  });

  publisher.start("tile", "a".repeat(64));
  publisher.publish("tile", firstSnapshot);
  await settle();
  await publisher.stop("tile");

  expect(reports).toEqual(["tile telemetry publish failed for tile", "tile telemetry stop failed for tile"]);
});
