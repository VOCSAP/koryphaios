# Prosopon

Prosopon gives the transcript a readable, guarded layout: framed prompts and assistant blocks, dimmed short assistant notes, and a rule closing each turn.

## Install

```text
/plugin install prosopon@choregos
```

The layout runs on Claude Code `2.1.303` or any later release, in a terminal of at least 40 columns; a development build or an unreadable version keeps the stock renderer. Every other version, surface and malformed input uses Claude Code's stock renderer, and so do the short limit or quota messages it recognises: at most 400 characters and 3 lines, holding `limit`, `reset`, `quota`, `overloaded` or `usage`.

## What it draws

- A one-line, non-summary assistant note of at most 160 characters draws with Claude Code's dimmed native assistant marker (U+25CF) followed by its own Markdown. It does not call render hooks placed beneath Prosopon; a rewrite already present in its input text is drawn.
- Other assistant blocks are framed around what the rest of the render chain returns. A prompt typed at the composer is framed under `You`; task notifications, messages from peers or channels, and bridge or SDK turns keep the stock rendering.
- A turn ends with a dimmed rule such as `── Baked for 3s ───…`, two columns shorter than the terminal.

## Tool headers

A closed tool call keeps Claude Code's green marker and its native label, drawn dimmed: `Bash(command)`, `Update(path)` for `Edit`, `Write(path)`, `Skill(name)` for a name not starting with `/`, `Fetch(url)` for `WebFetch`, `Web Search("query")` and `Agent(description)` for an agent with no type or `general-purpose`. A running, failed, interrupted or expanded call, an argument that is not short printable ASCII, a path outside the session directory and a label that would wrap differently keep the stock header.

`TodoWrite`, `ToolSearch` and `NotebookEdit` draw no header of their own, MCP calls already draw a dimmed `Called <server>` row, and a typed agent is titled with its type, so they stay stock.

## Tool runs

On Claude Code `2.1.310` or later, two or more tool calls in a row, with no text from Claude and no prompt between them, draw as one dimmed row under the green marker: `5 calls: Bash x3, Read, claude-peers`. It names at most four tools, the most frequent first, then `+N more`, and an MCP tool by its server. It adds `, 1 error` when a call failed and `· running Bash` while a call runs. A message from a peer does not split a run, and a subagent call ends it and keeps its own row.

A failed or interrupted call keeps its own rows, ctrl+o shows every call in full, and a single call keeps its header. After `--resume`, the reprinted history keeps its rows and only the calls made since are grouped.

## Configuration

- Set `labels` to `fr` for `Vous`; any other value gives `You`.
- Set `user_label` to a label of at most 20 code points without control characters; invalid and empty values use the language label.
- Set `user_color` and `assistant_color` to a color name (`red`, `orange`, `yellow`, `green`, `cyan`, `blue`, `purple`, `magenta`, `pink`, `gray`, `grey`, `white`, `black`, case ignored), a Claude Code theme color or `#rrggbb`; invalid values use `suggestion` and `claude` respectively.

Summary blocks keep Claude Code's stock rendering.
