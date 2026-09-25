// Built-in guard rules, active in every Kory session whatever the repository:
// each one must stay generic. Anything specific to one repository is a repo
// rule instead. Patterns are written with escapes only: this file must never
// hold a literal control byte or a literal secret.

import { qualifyRule, type TtsrEffectiveRule, type TtsrRule } from './ttsr-rules'

const TEXT_WRITERS: TtsrRule['tools'] = ['Edit', 'MultiEdit', 'Write']

// A git invocation, optionally with `-C <dir>`, then the subcommand.
const GIT = String.raw`\bgit\s+(?:-C\s+\S+\s+)?`
// Rest of the same shell command: stops at a separator or a newline.
const SAME_CMD = String.raw`[^;&|\n]*?`

export const KORY_RULES: readonly TtsrRule[] = [
  {
    id: 'empty-catch',
    event: 'PreToolUse',
    tools: [...TEXT_WRITERS],
    field: 'added',
    pattern: String.raw`\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}|\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*\{\s*\}\s*\)`,
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
    pattern: `${GIT}add\\b${SAME_CMD}\\s(?:-A|--all|\\.)(?=[\\s;&|)]|$)`,
    mode: 'deny',
    message:
      'Do not stage everything with git add -A / --all / .: stage the files you changed explicitly by name, then check git status.'
  },
  {
    id: 'git-no-verify',
    event: 'PreToolUse',
    tools: ['Bash'],
    field: 'command',
    pattern: String.raw`(?:^|\s)--no-verify(?=[\s;&|)=]|$)`,
    mode: 'deny',
    message:
      'Do not bypass git hooks with --no-verify: fix what the hook reports, or ask the operator if the hook itself is wrong.'
  },
  {
    id: 'git-force-push',
    event: 'PreToolUse',
    tools: ['Bash'],
    field: 'command',
    // --force-with-lease / --force-if-includes are excluded by the (?!-) lookahead.
    pattern: `${GIT}push\\b${SAME_CMD}\\s(?:--force(?![-\\w])|-[A-Za-z]*f[A-Za-z]*(?=[\\s;&|)]|$)|\\+[^\\s+])`,
    mode: 'deny',
    message:
      'Do not force-push: it can destroy commits on the remote. Use --force-with-lease if a rewrite is really needed, and ask the operator first on a shared branch.'
  },
  {
    id: 'secret-literal',
    event: 'PreToolUse',
    tools: [...TEXT_WRITERS],
    field: 'added',
    pattern: String.raw`\bsk-ant-[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----`,
    mode: 'deny',
    message:
      'This looks like a credential (API key, token or private key): never write it into a file. Read it from an environment variable or a secret store, and ask the operator to rotate it if it was exposed.'
  }
]

export const KORY_EFFECTIVE_RULES: readonly TtsrEffectiveRule[] = KORY_RULES.map((r) =>
  qualifyRule('kory', r)
)
