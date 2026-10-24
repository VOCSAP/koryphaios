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

## Configuration

- Set `labels` to `fr` for `Vous`; any other value gives `You`.
- Set `user_label` to a label of at most 20 code points without control characters; invalid and empty values use the language label.
- Set `user_color` and `assistant_color` to a color name (`red`, `orange`, `yellow`, `green`, `cyan`, `blue`, `purple`, `magenta`, `pink`, `gray`, `grey`, `white`, `black`, case ignored), a Claude Code theme color or `#rrggbb`; invalid values use `suggestion` and `claude` respectively.

Summary blocks keep Claude Code's stock rendering.
