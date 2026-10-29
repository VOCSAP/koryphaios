import { expect, test } from "bun:test";
import { isToolNameList, liftDisallowedTools } from "../desktop/src/shared/tool-names.ts";

const namesOf = (count: number): string[] => Array.from({ length: count }, (_, i) => `Tool${i}`);

test("a list is valid up to 64 names and refused one name past it", () => {
  expect(isToolNameList(namesOf(64))).toBe(true);
  expect(isToolNameList(namesOf(65))).toBe(false);
});

test("a name is valid up to 128 characters and refused one character past it", () => {
  expect(isToolNameList(["a".repeat(128)])).toBe(true);
  expect(isToolNameList(["a".repeat(129)])).toBe(false);
});

test.each([
  ["a space", "Bash git"],
  ["a dollar", "$HOME"],
  ["a command substitution", "$(id)"],
  ["a comma inside one name", "Write,Edit"],
  ["a trailing newline", "Write\n"],
  ["a backtick", "`id`"],
  ["a double quote", 'a"b'],
  ["a semicolon", "a;b"],
  ["an empty name", ""]
])("a name with %s refuses the whole list", (_label, name) => {
  expect(isToolNameList([name])).toBe(false);
  expect(isToolNameList(["Write", name])).toBe(false);
});

test("permission-rule and MCP shapes are accepted", () => {
  expect(isToolNameList(["mcp__a-b__c", "Bash(git:*)", "Write", "Edit_2"])).toBe(true);
});

test("the empty list is valid and means no denial, and a non-list or non-string entry is refused", () => {
  expect(isToolNameList([])).toBe(true);
  for (const value of [undefined, null, "Write", { 0: "Write" }, [42], [null], [["Write"]]]) {
    expect(isToolNameList(value), JSON.stringify(value)).toBe(false);
  }
});

test("lift moves the pair the Deck wrote out of args into the field", () => {
  expect(liftDisallowedTools('--disallowedTools "Write,Edit,NotebookEdit"', undefined)).toEqual({
    args: "",
    disallowedTools: ["Write", "Edit", "NotebookEdit"]
  });
  expect(liftDisallowedTools('--agent reviewer --disallowedTools "Write,Edit" --model opus', undefined)).toEqual({
    args: "--agent reviewer --model opus",
    disallowedTools: ["Write", "Edit"]
  });
  expect(liftDisallowedTools("--agent x --disallowedTools Write,Edit", undefined)).toEqual({
    args: "--agent x",
    disallowedTools: ["Write", "Edit"]
  });
});

test("lift leaves args alone when the field is already set", () => {
  const args = '--disallowedTools "Write,Edit"';
  expect(liftDisallowedTools(args, ["Bash"])).toEqual({ args, disallowedTools: ["Bash"] });
});

test("lift leaves args alone, and sets no field, for a list outside the allow-list", () => {
  for (const args of [
    '--disallowedTools "Write,$(id)"',
    '--disallowedTools "Write, Edit"',
    '--disallowedTools ""',
    '--disallowedTools "Write;rm"'
  ]) {
    expect(liftDisallowedTools(args, undefined), args).toEqual({ args, disallowedTools: undefined });
  }
});

test("lift never truncates a quoted rule that holds a space: args stay intact", () => {
  const args = '--disallowedTools "Bash(git push:*),Write" --verbose';
  expect(liftDisallowedTools(args, undefined)).toEqual({ args, disallowedTools: undefined });
});

test("lift leaves args alone when a bare word follows the pair, since the CLI reads it as one more tool name", () => {
  for (const args of ["--disallowedTools A B", '--disallowedTools "Write" Edit', "--agent x --disallowedTools Write,Edit extra"]) {
    expect(liftDisallowedTools(args, undefined), args).toEqual({ args, disallowedTools: undefined });
  }
});

test("lift still lifts a pair that is followed by another flag, quoted or bare, and keeps that flag", () => {
  expect(liftDisallowedTools('--disallowedTools "Write,Edit" --verbose', undefined)).toEqual({
    args: "--verbose",
    disallowedTools: ["Write", "Edit"]
  });
  expect(liftDisallowedTools("--disallowedTools Write,Edit -p", undefined)).toEqual({
    args: "-p",
    disallowedTools: ["Write", "Edit"]
  });
});

test("lift needs the quotes to pair up", () => {
  for (const args of ['--disallowedTools "Write,Edit', '--disallowedTools Write,Edit"', '--disallowedTools "Write,Edit"x']) {
    expect(liftDisallowedTools(args, undefined), args).toEqual({ args, disallowedTools: undefined });
  }
});

test("lift leaves args alone when the flag appears twice or not at all", () => {
  const twice = '--disallowedTools "Write" --disallowedTools "Edit"';
  expect(liftDisallowedTools(twice, undefined)).toEqual({ args: twice, disallowedTools: undefined });
  expect(liftDisallowedTools("--agent x", undefined)).toEqual({ args: "--agent x", disallowedTools: undefined });
  expect(liftDisallowedTools("--disallowedToolsExtra Write", undefined)).toEqual({
    args: "--disallowedToolsExtra Write",
    disallowedTools: undefined
  });
});
