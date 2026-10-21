# Prosopon

Prosopon frames the transcript with a readable, guarded layout: your prompts typed at the composer, the assistant's blocks, and a rule closing each turn.

## Install

```text
/plugin install prosopon@choregos
```

The layout runs on Claude Code `2.1.303` or any later release, in a terminal of at least 40 columns; a development build or an unreadable version keeps the stock renderer. Every other version, surface and malformed input uses Claude Code's stock renderer, and so do the short limit or quota messages it recognises: at most 400 characters and 3 lines, holding `limit`, `reset`, `quota`, `overloaded` or `usage`.

## What it draws

- An assistant block is framed around what the rest of the render chain returns. A hook that rewrites the text, such as Mitos adding file links, keeps its rewrite inside the frame whichever of the two plugins loads first.
- A prompt typed at the composer is framed under `You`. Task notifications, messages from peers or channels and bridge or SDK turns keep the stock rendering.
- A turn ends with a dimmed rule such as `── Baked for 3s ───…`, two columns shorter than the terminal.

Set the `labels` option to `fr` for `Vous`; any other value gives `You`.

The layout has not been proven against a corpus of real captures before L2. Keep it opt-in until that corpus is available.

Summary blocks keep Claude Code's stock rendering for now. Their dimmed, indented line waits for L2's differential capture of the stock and plugin renders, because the indentation changes where lines wrap.
