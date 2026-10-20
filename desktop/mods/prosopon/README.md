# Prosopon

Prosopon renders eligible assistant transcript blocks with a readable, guarded layout.

## Install

```text
/plugin install prosopon@choregos
```

The layout runs on Claude Code `2.1.303` or any later release, in a terminal of at least 40 columns; a development build or an unreadable version keeps the stock renderer. Every other version, surface and malformed input uses Claude Code's stock renderer, and so do the short limit or quota messages it recognises: at most 400 characters and 3 lines, holding `limit`, `reset`, `quota`, `overloaded` or `usage`.

The layout has not been proven against a corpus of real captures before L2. Keep it opt-in until that corpus is available.

Summary blocks keep Claude Code's stock rendering for now. Their dimmed, indented line waits for L2's differential capture of the stock and plugin renders, because the indentation changes where lines wrap.
