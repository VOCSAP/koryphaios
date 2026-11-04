import { expect, test } from "bun:test";
import { liftTemplateLaunchOptions } from "../desktop/src/shared/template-launch-options.ts";
import { sanitizeFlagValue } from "../desktop/src/main/session-command.ts";
import { sanitizeFlagValue as sharedSanitize } from "../desktop/src/shared/flag-value.ts";

test("main re-exports the shared sanitizer instead of duplicating it", () => {
  expect(sanitizeFlagValue).toBe(sharedSanitize);
});

test("the prefix create() writes is lifted, agent then model, each alone or together", () => {
  expect(liftTemplateLaunchOptions({ args: `--agent "dev" --model "opus" --verbose` })).toEqual({
    args: "--verbose",
    agent: "dev",
    model: "opus",
    unresolvedAgent: false,
    unresolvedModel: false
  });
  expect(liftTemplateLaunchOptions({ args: `--model "claude-opus-4-8[1m]"` })).toMatchObject({ args: "", model: "claude-opus-4-8[1m]" });
  expect(liftTemplateLaunchOptions({ args: `--agent "dev"` })).toMatchObject({ args: "", agent: "dev" });
});

test("a structured field already present is never overridden, and the flag in args is reported", () => {
  const out = liftTemplateLaunchOptions({ args: `--agent "x" --model "y"`, agent: "dev" });
  expect(out).toMatchObject({ agent: "dev", unresolvedAgent: true, unresolvedModel: true });
  expect(out.args).toBe(`--agent "x" --model "y"`);
});

test("a leading model is lifted while a later agent stays in args and is reported", () => {
  expect(liftTemplateLaunchOptions({ args: `--model "a" --agent "b"` })).toEqual({
    args: `--agent "b"`,
    agent: undefined,
    model: "a",
    unresolvedAgent: true,
    unresolvedModel: false
  });
});

test.each([
  ["duplicate", `--model "a" --model "b"`],
  ["single quotes", `--model 'a'`],
  ["equals", `--model=a`],
  ["short", `-m a`],
  ["invalid value", `--model "a;b"`],
  ["not leading", `--verbose --model "a"`]
])("%s leaves args untouched and reports unresolved", (_label, args) => {
  const out = liftTemplateLaunchOptions({ args });
  expect(out.args).toBe(args);
  expect(out.unresolvedModel || out.unresolvedAgent).toBe(true);
  expect(out.model).toBeUndefined();
});

test("args without any such flag are returned as given and resolved", () => {
  expect(liftTemplateLaunchOptions({ args: "  --verbose " })).toEqual({
    args: "  --verbose ",
    agent: undefined,
    model: undefined,
    unresolvedAgent: false,
    unresolvedModel: false
  });
  expect(liftTemplateLaunchOptions({})).toMatchObject({ args: "", unresolvedAgent: false });
});
