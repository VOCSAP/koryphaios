import { describe, expect, test } from "bun:test";
import type { WriterGeneration } from "../shared/peer-cache.ts";
import {
  canonicalWriterGeneration,
  keepsActiveWithoutHeartbeat,
  pidExists,
  relayPidAlive,
  resumeRefusal,
  type MeasureGeneration,
  type ResumeCandidate,
  type ResumeClaim,
  type SignalProbe,
} from "../shared/relay-liveness.ts";

const HOST = "broker-host";

const alive: SignalProbe = () => true;
const failing = (code: string): SignalProbe => () => {
  throw Object.assign(new Error(code), { code });
};
/** A probe that records every pid it was asked about. */
function recording(): { probe: SignalProbe; seen: number[] } {
  const seen: number[] = [];
  return {
    seen,
    probe: (pid) => {
      seen.push(pid);
      return true;
    },
  };
}

describe("pidExists", () => {
  test("a pid that is not a positive integer is never probed and never alive", () => {
    const { probe, seen } = recording();
    for (const pid of [0, -1, -4242, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pidExists(pid, probe), `pid ${pid}`).toBe(false);
    }
    expect(seen, "kill(0, 0) would signal the caller's whole process group").toEqual([]);
  });

  test("EPERM means the process exists under another account, ESRCH means it is gone", () => {
    expect(pidExists(4242, failing("EPERM"))).toBe(true);
    expect(pidExists(4242, failing("ESRCH"))).toBe(false);
    expect(pidExists(4242, failing("EINVAL"))).toBe(false);
  });

  test("the default probe sees the current process and not an unused pid", () => {
    expect(pidExists(process.pid)).toBe(true);
    expect(pidExists(999_999_999)).toBe(false);
  });
});

describe("relayPidAlive", () => {
  test("a pid of another host is not probed: the broker cannot see it", () => {
    const { probe, seen } = recording();
    expect(relayPidAlive({ host: "other-host", pid: 4242 }, HOST, probe)).toBe(false);
    expect(seen).toEqual([]);
  });

  test("a pid of this host is alive when the probe says so", () => {
    expect(relayPidAlive({ host: HOST, pid: 4242 }, HOST, alive)).toBe(true);
    expect(relayPidAlive({ host: HOST, pid: 4242 }, HOST, failing("ESRCH"))).toBe(false);
  });
});

describe("canonicalWriterGeneration", () => {
  test("each platform has one fixed key order, the pid included", () => {
    expect(canonicalWriterGeneration({ platform: "win32", pid: 7, creationUtc: "2026-11-08T10:00:00.1234567Z" })).toBe(
      '{"platform":"win32","pid":7,"creationUtc":"2026-11-08T10:00:00.1234567Z"}'
    );
    expect(canonicalWriterGeneration({ platform: "linux", pid: 7, startToken: "99", bootId: "boot-a" })).toBe(
      '{"platform":"linux","pid":7,"startToken":"99","bootId":"boot-a"}'
    );
  });
});

describe("keepsActiveWithoutHeartbeat", () => {
  const generation: WriterGeneration = { platform: "linux", pid: 4242, startToken: "100", bootId: "boot-a" };
  const local = { host: HOST, pid: 4242, relay_id: null, via: null, pid_generation: canonicalWriterGeneration(generation) };
  const measuredAs = (measured: WriterGeneration | null): { measure: MeasureGeneration; calls: number[] } => {
    const calls: number[] = [];
    return {
      calls,
      measure: async (pid) => {
        calls.push(pid);
        return measured;
      },
    };
  };

  test("a live local relay still running as the registered process keeps its peer in local and replica modes only", async () => {
    const { measure } = measuredAs(generation);
    expect(await keepsActiveWithoutHeartbeat("local", local, HOST, measure, alive)).toBe(true);
    expect(await keepsActiveWithoutHeartbeat("replica", local, HOST, measure, alive)).toBe(true);
    expect(await keepsActiveWithoutHeartbeat("remote", local, HOST, measure, alive)).toBe(false);
  });

  test("a pid reused by another process, an unmeasurable pid and a row without generation are not kept", async () => {
    const reused = measuredAs({ ...generation, startToken: "101" });
    expect(await keepsActiveWithoutHeartbeat("local", local, HOST, reused.measure, alive), "reused pid").toBe(false);
    expect(await keepsActiveWithoutHeartbeat("local", local, HOST, measuredAs(null).measure, alive), "unmeasurable").toBe(false);
    const unmeasured = measuredAs(generation);
    expect(
      await keepsActiveWithoutHeartbeat("local", { ...local, pid_generation: null }, HOST, unmeasured.measure, alive),
      "no stored generation"
    ).toBe(false);
    expect(unmeasured.calls, "a row without generation is never measured").toEqual([]);
  });

  test("a dead relay, another host, a relayed row and a mirror row are not kept, and never measured", async () => {
    const { measure, calls } = measuredAs(generation);
    expect(await keepsActiveWithoutHeartbeat("local", local, HOST, measure, failing("ESRCH"))).toBe(false);
    expect(await keepsActiveWithoutHeartbeat("local", { ...local, host: "other-host" }, HOST, measure, alive)).toBe(false);
    expect(await keepsActiveWithoutHeartbeat("local", { ...local, relay_id: "relay-1" }, HOST, measure, alive), "relayed").toBe(false);
    expect(await keepsActiveWithoutHeartbeat("local", { ...local, via: "upstream" }, HOST, measure, alive), "mirror").toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("resumeRefusal", () => {
  const row: ResumeCandidate = {
    host: HOST,
    pid: 4242,
    group_id: "g1",
    pid_generation: "gen-1",
    relay_id: null,
    via: null,
  };
  const claim: ResumeClaim = { host: HOST, pid: 4242, group_id: "g1", pid_generation: "gen-1" };

  test("a matching claim on a live pid is accepted", () => {
    expect(resumeRefusal(row, claim, HOST, alive)).toBeNull();
  });

  test("each rule names its own refusal", () => {
    const verdicts = {
      not_local: resumeRefusal({ ...row, relay_id: "relay-1" }, claim, HOST, alive),
      mirror: resumeRefusal({ ...row, via: "upstream" }, claim, HOST, alive),
      group: resumeRefusal(row, { ...claim, group_id: "g2" }, HOST, alive),
      host: resumeRefusal(row, { ...claim, host: "other-host" }, HOST, alive),
      pid: resumeRefusal(row, { ...claim, pid: 4243 }, HOST, alive),
      generation: resumeRefusal(row, { ...claim, pid_generation: "gen-2" }, HOST, alive),
      pid_dead: resumeRefusal(row, claim, HOST, failing("ESRCH")),
    };
    expect(verdicts).toEqual({
      not_local: "not_local",
      mirror: "not_local",
      group: "group",
      host: "host",
      pid: "pid",
      generation: "generation",
      pid_dead: "pid_dead",
    });
  });

  test("a row that carries a generation refuses a claim without one", () => {
    expect(resumeRefusal(row, { ...claim, pid_generation: null }, HOST, alive)).toBe("generation");
  });

  test("a row without a generation accepts a claim with or without one", () => {
    const bare = { ...row, pid_generation: null };
    expect(resumeRefusal(bare, claim, HOST, alive)).toBeNull();
    expect(resumeRefusal(bare, { ...claim, pid_generation: null }, HOST, alive)).toBeNull();
  });

  test("the pid of another host is not probed", () => {
    const { probe, seen } = recording();
    const foreign = { ...row, host: "other-host" };
    expect(resumeRefusal(foreign, { ...claim, host: "other-host" }, HOST, probe)).toBeNull();
    expect(seen).toEqual([]);
  });
});
