import { test, expect } from "bun:test";
import { extractAuthUrl } from "../desktop/src/renderer/src/oauth-url";

// The sandbox login dialog reads the sign-in URL out of the raw PTY stream
// because the terminal wraps it across rows, where an xterm selection returns
// a broken string. These cases are the stream shapes the CLI actually emits.

test("finds a plain sign-in URL", () => {
  const url = "https://claude.ai/oauth/authorize?code=true&client_id=abc123&scope=user";
  expect(extractAuthUrl(`Browser didn't open? Use the url below:\r\n${url}\r\n`)).toBe(url);
});

test("sees through the colours and box drawing the CLI paints", () => {
  const url = "https://claude.ai/oauth/authorize?code=true&state=xyz";
  const painted = `\x1b[2m│\x1b[0m \x1b[1;34m${url}\x1b[0m \x1b[2m│\x1b[0m`;
  expect(extractAuthUrl(painted)).toBe(url);
});

// The regression that made the feature useless: the CLI hard-wraps the URL to
// the terminal width with a REAL newline, mid-token, so a whitespace-stopping
// regex handed back "…response_type=co" and OAuth answered "missing
// redirect_uri". Rows here are 60 wide, like the real stream at 110.
test("rejoins a url the CLI hard-wrapped across rows", () => {
  const stream = [
    "Browser didn't open? Use the url below to sign in (c to copy)",
    "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1",
    "c250a&response_type=code&redirect_uri=https%3A%2F%2Fplatform.c",
    "laude.com%2Foauth%2Fcode%2Fcallback&state=DKbzEY",
    "",
    "Paste code here if prompted >"
  ].join("\r\n");
  expect(extractAuthUrl(stream)).toBe(
    "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a" +
      "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com" +
      "%2Foauth%2Fcode%2Fcallback&state=DKbzEY"
  );
});

// The counterpart: a url that stops MID-row was never wrapped, so the prose
// under it must not be glued on.
test("does not glue the next row onto a url that ended mid-row", () => {
  const stream = "see https://claude.ai/oauth?a=1 for details\r\nthen-paste-the-code\r\n";
  expect(extractAuthUrl(stream)).toBe("https://claude.ai/oauth?a=1");
});

// The regression that survived the first fix: the rows of a wrapped block do
// NOT all have the terminal's width. Here they are 112 / 113 / 116 / 113 / 2,
// which an equality-on-width walk truncated after a single join (451 -> 225).
// The walk must not measure rows at all.
test("rejoins rows of UNEVEN length, stopping at the blank line", () => {
  const rows = [
    "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=co",
    "de&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Apr",
    "ofile+user%3Ainference+user%3Asessions+user%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_challenge=q7yKn",
    "6JKuHi_ggNV4xaSv14M3Mk-w8-YcojZSOWLX0&code_challenge_method=S256&state=DKbzEY_3p6nFepDjRIXo37bOdhf3okqw_0BKX2m1V",
    "j0"
  ];
  // Rows really are of different lengths -- that is the whole point.
  expect(new Set(rows.slice(0, 4).map((r) => r.length)).size).toBeGreaterThan(1);
  const stream = ["Browser didn't open? Use the url below to sign in (c to copy)", ...rows, "", "Paste code here if prompted >"].join("\r\n");
  const url = extractAuthUrl(stream);
  expect(url).toBe(rows.join(""));
  // The failure the operator saw was a length, so assert one.
  expect(url).toHaveLength(rows.join("").length);
  expect(url).toContain("redirect_uri=");
  expect(url).toContain("state=");
});

test("stops rejoining at a row that contains whitespace", () => {
  const stream = ["https://claude.ai/oauth?a=1", "23456", "then paste the code"].join("\n");
  expect(extractAuthUrl(stream)).toBe("https://claude.ai/oauth?a=123456");
});

test("takes the LAST url: a retry supersedes the previous link", () => {
  const first = "https://claude.ai/oauth/authorize?code=1";
  const second = "https://claude.ai/oauth/authorize?code=2";
  expect(extractAuthUrl(`${first}\r\nexpired, retrying\r\n${second}\r\n`)).toBe(second);
});

test("drops sentence punctuation glued to the end", () => {
  expect(extractAuthUrl("open https://claude.ai/oauth/authorize?a=1.")).toBe(
    "https://claude.ai/oauth/authorize?a=1"
  );
});

test("no url, or nothing but a bare scheme, yields null", () => {
  expect(extractAuthUrl("Logging in… please wait")).toBeNull();
  expect(extractAuthUrl("")).toBeNull();
  expect(extractAuthUrl("https://")).toBeNull();
});
