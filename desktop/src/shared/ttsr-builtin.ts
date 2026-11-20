// Built-in guard rules, active in every Kory session whatever the repository:
// each one must stay generic. Anything specific to one repository is a repo
// rule instead. Patterns are written with escapes only: this file must never
// hold a literal control byte or a literal secret.

import { qualifyRule, type TtsrEffectiveRule, type TtsrRule } from './ttsr-rules'

const TEXT_WRITERS: TtsrRule['tools'] = ['Edit', 'MultiEdit', 'Write']

// Every quantifier below is bounded: a crafted 256 KiB input must not turn a
// built-in into the slow rule that holds the hook up.

// A shell word: single- or double-quoted string, or a run of plain characters.
const WORD = String.raw`(?:'[^']{0,2048}'|"(?:[^"\\]|\\[\s\S]){0,2048}"|[^\s'"]{1,2048})`
// Command position: start, or after a separator, a subshell or a brace, past
// shell keywords and VAR=value prefixes. A command name inside an argument (a
// commit message, a grep pattern) is not a command.
// Limit: a separator inside a quoted argument still counts as one, and a
// command reached through a path (/usr/bin/git) or a wrapper (xargs) is not seen.
const CMD =
  String.raw`(?:^|[\n;&|(){}` + '`' + String.raw`])[ \t]{0,64}` +
  String.raw`(?:(?:then|do|else|exec|command|time|nohup|sudo|env)[ \t]{1,16}|\w{1,64}=(?:'[^'\n]{0,256}'|"[^"\n]{0,256}"|[^\s'"]{0,256})[ \t]{1,16}){0,8}`
// `git`, its global options (-C dir, -c k=v, --no-pager, --git-dir=x, -p), then the subcommand.
const GIT =
  CMD + String.raw`git(?:[ \t]{1,16}(?:-[Cc][ \t]{1,16}${WORD}|--[a-z][a-z-]{0,63}(?:=${WORD})?|-[pP])){0,8}[ \t]{1,16}`
// End of a shell word.
const EOW = String.raw`(?=[\s;&|)]|$)`
// Rest of the same shell command, a quoted string consumed whole, so an
// option spelled inside a quoted argument is never taken for a flag.
const ARGS = String.raw`(?:[^;&|\n'"` + '`' + String.raw`]|'[^']{0,2048}'|"(?:[^"\\]|\\[\s\S]){0,2048}"){0,2048}?`
const SEG = ARGS + String.raw`[ \t]`

// A catch body holding nothing but whitespace and dismissive comments
// (`/* ignore */`, `// noop`, an empty comment). A comment that explains why
// the error may be dropped is a decision someone wrote down, not an empty catch.
const DISMISS = String.raw`(?:(?:[Ii]gnored?|[Nn]o-?op|[Nn]othing|[Ee]mpty|[Ss]wallow(?:ed)?|[Ss]ilent(?:ly)?|[Bb]est[- ]effort|[Ii]ntentional(?:ly empty)?)\.?)?`
const EMPTY_BODY = String.raw`\{\s{0,256}(?:(?:\/\*[ \t*]{0,16}${DISMISS}[ \t*]{0,16}\*\/|\/\/[ \t]{0,16}${DISMISS}[ \t]{0,16}\n)\s{0,256}){0,4}\}`
// Not a real credential: a documented placeholder (runs of x, *, ., zeros, a template slot).
const PLACEHOLDER = String.raw`(?![a-z]{0,8}\d{0,4}-?(?:[xX*.]{4}|0{8}|<|\$\{|\{\{))`
export const KORY_RULES: readonly TtsrRule[] = [
  {
    id: 'empty-catch',
    event: 'PreToolUse',
    tools: [...TEXT_WRITERS],
    field: 'added',
    // Documentation quotes code: Markdown is exempt. A `catch {}` inside a
    // string literal is skipped only right after the opening quote.
    paths: ['!**/*.md', '!**/*.mdx'],
    pattern:
      String.raw`(?<![\w'"` + '`' + String.raw`.$])catch\s{0,16}(?:\([^()\n]{0,256}\)\s{0,16})?${EMPTY_BODY}` +
      String.raw`|\.catch\(\s{0,16}(?:async[ \t]{1,16})?(?:\([^()]{0,256}\)|\w{1,64})[ \t]{0,16}(?::[^=()]{0,128})?=>\s{0,16}${EMPTY_BODY}\s{0,16}\)` +
      String.raw`|\.catch\(\s{0,16}(?:async[ \t]{1,16})?function\b[ \t]{0,16}\w{0,64}[ \t]{0,16}\([^()]{0,256}\)\s{0,16}${EMPTY_BODY}\s{0,16}\)`,
    mode: 'deny',
    message:
      'Do not swallow errors with an empty catch: log the error with context through the project logger, handle the specific failure you expect, or rethrow.'
  },
  {
    id: 'control-byte',
    event: 'PreToolUse',
    tools: [...TEXT_WRITERS],
    field: 'added',
    pattern: '[\\x00\\x07\\x1b]',
    mode: 'deny',
    message:
      'The text holds a raw NUL, BEL or ESC byte, which makes git treat the file as binary: write the escape sequence (\\x00, \\x07, \\x1b or \\u001b) instead.'
  },
  {
    id: 'git-add-all',
    event: 'PreToolUse',
    tools: ['Bash'],
    field: 'command',
    pattern: String.raw`${GIT}add${EOW}${SEG}(?:-A|--all|\.|:/)${EOW}`,
    mode: 'deny',
    message:
      'Do not stage everything with git add -A / --all / .: stage the files you changed explicitly by name, then check git status.'
  },
  {
    id: 'git-no-verify',
    event: 'PreToolUse',
    tools: ['Bash'],
    field: 'command',
    // Only inside a git command that runs hooks; `git commit -n` is the short
    // form (for push and merge, -n means something else).
    pattern:
      String.raw`${GIT}(?:commit|push|merge|rebase|am|cherry-pick|revert|pull)${EOW}${SEG}--no-verify(?=[\s;&|)=]|$)` +
      String.raw`|${GIT}commit${EOW}${SEG}-[apseiovqz]{0,8}n[A-Za-z]{0,16}${EOW}`,
    mode: 'deny',
    message:
      'Do not bypass git hooks with --no-verify: fix what the hook reports, or ask the operator if the hook itself is wrong.'
  },
  {
    id: 'git-force-push',
    event: 'PreToolUse',
    tools: ['Bash'],
    field: 'command',
    // --force-with-lease / --force-if-includes are excluded by the (?![-\w])
    // lookahead; -o takes a value, so a bundle holding it is not scanned for f.
    pattern: String.raw`${GIT}push${EOW}${SEG}(?:--force(?![-\w])|-[uqvnd46]{0,8}f[A-Za-z]{0,16}${EOW}|\+[^\s+])`,
    mode: 'deny',
    message:
      'Do not force-push: it can destroy commits on the remote. Use --force-with-lease if a rewrite is really needed, and ask the operator first on a shared branch.'
  },
  {
    id: 'secret-literal',
    event: 'PreToolUse',
    tools: [...TEXT_WRITERS],
    field: 'added',
    pattern:
      String.raw`\bsk-ant-${PLACEHOLDER}[A-Za-z0-9_-]{8,256}|\bsk-proj-${PLACEHOLDER}[A-Za-z0-9_-]{20,256}` +
      String.raw`|\bgh[pousr]_${PLACEHOLDER}[A-Za-z0-9]{20,255}|\bgithub_pat_${PLACEHOLDER}[A-Za-z0-9_]{20,255}` +
      String.raw`|\bxox[baprs]-${PLACEHOLDER}[A-Za-z0-9-]{10,255}` +
      // AKIAIOSFODNN7EXAMPLE is the key AWS documentation uses.
      String.raw`|\bAKIA(?!IOSFODNN7EXAMPLE)[0-9A-Z]{16}\b|-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----`,
    mode: 'deny',
    message:
      'This looks like a credential (API key, token or private key): never write it into a file. Read it from an environment variable or a secret store, and ask the operator to rotate it if it was exposed.'
  },
  // The `warn` rules below are signals shown to the operator on a permission
  // request, never a verdict: a call they do not match is not safe.
  {
    id: 'rm-recursive',
    event: 'PreToolUse',
    tools: ['Bash'],
    field: 'command',
    pattern: String.raw`${CMD}rm${EOW}${SEG}(?:--recursive|-[a-zA-Z]{0,8}[rR][a-zA-Z]{0,8})${EOW}`,
    flags: 'i',
    mode: 'warn',
    message: 'Recursive delete: removes a whole directory tree, outside the trash.'
  },
  {
    id: 'ps-remove-recursive',
    event: 'PreToolUse',
    tools: ['Bash'],
    field: 'command',
    // `rm` is left to rm-recursive so one command raises one signal. Accepts -r up
    // to -Recurse; a longer parameter such as -Force never matches.
    pattern:
      String.raw`${CMD}(?:remove-item|ri|del|erase|rd|rmdir)${EOW}${SEG}-r(?:e(?:c(?:u(?:r(?:se?)?)?)?)?)?(?![\w-])`,
    flags: 'i',
    mode: 'warn',
    message: 'PowerShell recursive delete: removes a whole directory tree, outside the Recycle Bin.'
  },
  {
    id: 'cmd-rmdir-recursive',
    event: 'PreToolUse',
    tools: ['Bash'],
    field: 'command',
    // `/s/q` is one word in cmd, so the switch ends at a slash as well.
    pattern: String.raw`${CMD}(?:rmdir|rd)${EOW}${SEG}/s(?!\w)`,
    flags: 'i',
    mode: 'warn',
    message: 'cmd recursive delete (rmdir /s): removes a whole directory tree, outside the Recycle Bin.'
  },
  {
    id: 'sql-drop',
    event: 'PreToolUse',
    tools: ['Bash'],
    field: 'command',
    pattern: String.raw`\bdrop\s{1,16}(?:table|database)\b`,
    flags: 'i',
    mode: 'warn',
    message: 'SQL DROP of a table or a database: the data is lost unless it was backed up.'
  },
  {
    id: 'chmod-777-recursive',
    event: 'PreToolUse',
    tools: ['Bash'],
    field: 'command',
    pattern:
      String.raw`${CMD}chmod${EOW}(?=${SEG}(?:--recursive|-[a-zA-Z]{0,8}R[a-zA-Z]{0,8})${EOW})(?=${SEG}0?777${EOW})`,
    mode: 'warn',
    message: 'Recursive chmod 777: makes a whole tree writable by everyone.'
  },
  {
    id: 'pipe-to-shell',
    event: 'PreToolUse',
    tools: ['Bash'],
    field: 'command',
    // `||` never matches: the character after the first `|` must start a shell name.
    pattern:
      String.raw`${CMD}(?:curl|wget)${EOW}${ARGS}\|[ \t]{0,16}` +
      String.raw`(?:sudo(?:[ \t]{1,16}-{1,2}[\w=-]{1,32}){0,4}[ \t]{1,16})?(?:ba|z|da|a)?sh${EOW}`,
    mode: 'warn',
    message: 'A downloaded script piped straight into a shell: nobody reviewed what it runs.'
  },
  {
    id: 'dd-to-device',
    event: 'PreToolUse',
    tools: ['Bash'],
    field: 'command',
    pattern: String.raw`${CMD}dd${EOW}${SEG}of=/dev/(?!(?:null|zero|stdout|stderr)${EOW})`,
    mode: 'warn',
    message: 'dd writing to a device under /dev: overwrites a whole disk or partition.'
  },
  {
    id: 'mkfs',
    event: 'PreToolUse',
    tools: ['Bash'],
    field: 'command',
    pattern: String.raw`${CMD}mkfs(?:\.[a-z0-9]{1,16})?${EOW}`,
    mode: 'warn',
    message: 'mkfs builds a new filesystem: the data of the device is erased.'
  },
  {
    id: 'git-reset-hard',
    event: 'PreToolUse',
    tools: ['Bash'],
    field: 'command',
    pattern: String.raw`${GIT}reset${EOW}${SEG}--hard${EOW}`,
    mode: 'warn',
    message: 'git reset --hard discards every uncommitted change.'
  },
  {
    id: 'git-clean-force',
    event: 'PreToolUse',
    tools: ['Bash'],
    field: 'command',
    // -n (dry run) in a bundle leaves the rule silent.
    pattern: String.raw`${GIT}clean${EOW}${SEG}(?:--force|-[a-mo-zA-Z]{0,8}f[a-mo-zA-Z]{0,8})${EOW}`,
    mode: 'warn',
    message: 'git clean -f deletes untracked files for good.'
  }
]

export const KORY_EFFECTIVE_RULES: readonly TtsrEffectiveRule[] = KORY_RULES.map((r) =>
  qualifyRule('kory', r)
)
