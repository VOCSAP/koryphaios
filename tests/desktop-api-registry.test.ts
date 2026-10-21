// api-registry.ts imports `ipcMain` from 'electron' at module scope, which
// bun test cannot resolve outside a real Electron process (SyntaxError:
// export not found in the electron npm package's stub index.js) -- 'electron'
// is mocked BEFORE the import so the module loads at all. isLocalIpcEvent
// itself never touches ipcMain, only the module's top-level import does.
import { test, expect, mock } from "bun:test";

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
mock.module("electron", () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => ipcHandlers.set(channel, fn), on: () => {} },
}));

const { isLocalIpcEvent, regHandle, invokeRemote } = await import("../desktop/src/main/api-registry.ts");
const { previewHandler } = await import("../desktop/src/main/image-preview-service.ts");

// Card 64f8f629: isLocalIpcEvent answers the POSITIVE question ("is this
// genuinely local") on purpose -- every value below that this function does
// not recognize must fall on the UNATTENDED side, never the attended one.
// A mutation that flips the polarity (e.g. `!isRemoteEvent`-shaped logic)
// must turn at least one of these red.
test("isLocalIpcEvent: undefined and null are not local", () => {
  expect(isLocalIpcEvent(undefined)).toBe(false);
  expect(isLocalIpcEvent(null)).toBe(false);
});

test("isLocalIpcEvent: a plain empty object is not local", () => {
  expect(isLocalIpcEvent({})).toBe(false);
});

// The companion's REMOTE_EVENT sentinel shape, forged by hand rather than
// imported (api-registry.ts does not export it): a caller impersonating this
// shape must NOT read as local, proving the check is not structural on
// `remote` at all.
test("isLocalIpcEvent: an object shaped like the REMOTE_EVENT sentinel is not local", () => {
  expect(isLocalIpcEvent({ remote: true })).toBe(false);
});

test("isLocalIpcEvent: an object carrying a `sender` property is local", () => {
  expect(isLocalIpcEvent({ sender: {} })).toBe(true);
});

test("shell:preview-image: a companion call through the real registry is refused and never reaches the service, a real ipcMain event does", async () => {
  const asked: unknown[][] = [];
  const service = {
    preview: async (id: number, target: unknown) => (asked.push([id, target]), { ok: true as const, dataUrl: "d", width: 1, height: 1 }),
  };
  regHandle("shell:preview-image", previewHandler(service, isLocalIpcEvent));

  expect(await invokeRemote("shell:preview-image", ["/a.png"])).toEqual({ ok: false, reason: "unavailable" });
  expect(asked, "the remote event must not read a file").toEqual([]);

  const local = ipcHandlers.get("shell:preview-image")!;
  expect(await local({ sender: { id: 7 } }, "/a.png")).toMatchObject({ ok: true });
  expect(asked).toEqual([[7, "/a.png"]]);
});
