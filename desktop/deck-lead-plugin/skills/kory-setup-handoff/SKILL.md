---
name: kory-setup-handoff
description: "Use when the operator wants to choose Kory or an external tool for Kory session handoffs, or needs validated custom handoff instructions to paste into Settings > Skills."
disable-model-invocation: true
---

# Configure handoff storage

The operator owns this setting. You discover and validate a storage procedure, then show paste-ready text. You never call `skills:set`, edit Settings, or otherwise write the setting.

## 1. Choose storage

Ask one question: `Use Kory storage or custom storage?`

- **Kory**: explain that it is the default numbered handoff storage. Tell the operator to select Kory in Settings > Skills. Stop.
- **Custom**: continue. A custom instruction describes shell or tool commands for writing and reading a handoff. It never tells an agent to invoke a slash command.

## 2. Gather the custom contract

Ask these questions before drafting anything:

1. Which tool and account or workspace should own the handoff?
2. What command writes one complete handoff without relying on a repository-local setting or interpolating Markdown into a shell string or argument?
3. What command reads the newest handoff and, when supported, one requested handoff?
4. Does the write command receive Markdown through stdin, a temporary file path, or another structured input, and how does the read command return it?

Reject a command that would place secrets in source, settings, or the handoff. Reject one that interpolates generated Markdown into shell syntax or an argument; require stdin, a temporary file path, or another structured input instead. Ask for an environment-based alternative. Do not turn a command into a slash command.

## 3. Draft and prove the procedure

Write instructions in English for the three session skills. They must say how to:

1. write the complete eight-section handoff;
2. read it back for verification after writing;
3. read the latest handoff at session start, and a requested number when the tool supports it;
4. report the command's failure output so Kory can fall back to its own storage when writing fails.

Run an actual round trip before presenting the text. Use a realistic Markdown handoff containing all eight required sections, more than one card or task when relevant, ordinary Unicode text, and inert shell metacharacters such as backticks, quotes and `$()`. Write it with the proposed command, read it through the proposed command, and compare the complete content exactly.

| Result | Action |
|---|---|
| exact match | Continue. |
| different content | Name the difference and revise the procedure. |
| command failure | Show the command's first failure line and stop. Do not present unvalidated instructions. |

## 4. Give the operator the validated text

Show exactly this labelled block, with the validated procedure replacing the placeholder:

```text
Paste this into Settings > Skills > Handoff storage > Custom instructions:

<validated English commands for write, verify-read, latest-read, and requested-read>
```

State that the operator must paste it and save it. Do not save it yourself.
