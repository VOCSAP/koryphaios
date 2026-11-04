// Rules both the create popover and the template composer read: the same model
// choice and the same Context Size text must give the same recipe fields.
import { expect, test } from "bun:test";
import {
  canExtendPick,
  entryHasInvalidContext,
  formatContextK,
  isContextInvalid,
  mergeCreateCatalogs,
  modelFieldsOf,
  modelStateOf,
  parseContextK,
  sliderKOf,
  splitExtendedModel
} from "../desktop/src/renderer/src/peer-options";

test("a stored [1m] model splits into base and flag, then joins back to the same string", () => {
  const stored = modelStateOf({ model: "opus[1m]" });
  expect(stored).toEqual({ pick: { model: "opus" }, extended: true });
  expect(modelFieldsOf(stored.pick, stored.extended)).toEqual({ model: "opus[1m]", bridge: undefined });
});

test("the legacy trio of aliases and an unknown historical id are carried verbatim", () => {
  for (const id of ["opus", "sonnet", "haiku", "claude-3-5-sonnet-20241022"]) {
    const { pick, extended } = modelStateOf({ model: id });
    expect(modelFieldsOf(pick, extended).model).toBe(id);
  }
  expect(splitExtendedModel(undefined)).toEqual({ base: "", extended: false });
});

test("the suffix is dropped for Haiku and for a clodex pick, where it means nothing", () => {
  expect(canExtendPick({ model: "haiku" })).toBe(false);
  expect(modelFieldsOf({ model: "haiku" }, true).model).toBe("haiku");
  const bridged = modelFieldsOf({ model: "gpt-5", providerId: "clodex" }, true);
  expect(bridged).toEqual({ model: "gpt-5", bridge: "clodex" });
});

test("a bridged entry reads back as the clodex provider and keeps its model id", () => {
  expect(modelStateOf({ model: "gpt-5", bridge: "clodex" }).pick).toEqual({
    model: "gpt-5",
    providerId: "clodex"
  });
});

test("an empty model with no provider is the CLI default: no model and no bridge fields", () => {
  expect(modelFieldsOf({ model: "" }, true)).toEqual({ model: undefined, bridge: undefined });
});

test("launch-config models come first and the Anthropic frontier ids are not duplicated", () => {
  const merged = mergeCreateCatalogs(
    [{ id: "opus", label: "Opus" }],
    [
      {
        id: "anthropic",
        name: "Anthropic",
        kind: "frontier",
        cli: "claude",
        available: false,
        models: [{ id: "opus" }, { id: "claude-opus-4-1" }]
      },
      { id: "clodex", name: "OpenAI · clodex", kind: "bridge", cli: "claude", available: true, models: [] },
      { id: "ollama", name: "Ollama", kind: "local", cli: "local", available: true, models: [] }
    ]
  );
  expect(merged.map((c) => c.id)).toEqual(["anthropic", "clodex"]);
  expect(merged[0]!.models.map((m) => m.id)).toEqual(["opus", "claude-opus-4-1"]);
  expect(merged[0]!.available).toBe(true);
});

test("Context Size text parses inclusive bounds and exact fractional k, nothing else", () => {
  expect(parseContextK("200")).toBe(200_000);
  expect(parseContextK("872")).toBe(872_000);
  expect(parseContextK(" 250.5 ")).toBe(250_500);
  expect(parseContextK("250,5")).toBe(250_500);
  for (const bad of ["", "199", "872.001", "873", "1e3", "-300", "abc", "300.1234", "Infinity", "NaN"]) {
    expect(Number.isNaN(parseContextK(bad)), `"${bad}" must be refused`).toBe(true);
  }
});

test("formatContextK and parseContextK round-trip every valid k boundary and a fractional value", () => {
  for (const tokens of [200_000, 200_500, 345_001, 872_000]) {
    expect(parseContextK(formatContextK(tokens))).toBe(tokens);
  }
});

test("an invalid marker blocks a clodex entry only; the same value on another provider is inert", () => {
  expect(isContextInvalid(Number.NaN)).toBe(true);
  expect(isContextInvalid(199_999)).toBe(true);
  expect(isContextInvalid(undefined)).toBe(false);
  expect(entryHasInvalidContext({ bridge: "clodex", clodexContextTokens: Number.NaN })).toBe(true);
  expect(entryHasInvalidContext({ clodexContextTokens: Number.NaN })).toBe(false);
  expect(entryHasInvalidContext({ bridge: "clodex" })).toBe(false);
});

test("the slider parks on the 200k default for an absent or invalid value and rounds to whole k", () => {
  expect(sliderKOf(undefined)).toBe(200);
  expect(sliderKOf(Number.NaN)).toBe(200);
  expect(sliderKOf(345_600)).toBe(346);
});
