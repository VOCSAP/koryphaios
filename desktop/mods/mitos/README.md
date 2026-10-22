# Mitos

Mitos turns the bare file paths of an assistant reply into clickable `file:///` links. A path is linked only when it names an existing file, reached through no symbolic link or junction, with an allowed extension. Claude Code then draws the link as a terminal hyperlink (OSC 8), which a terminal that supports them opens on click.

## Install

```text
/plugin install mitos@choregos
```

Mitos runs on Claude Code `2.1.303` or any later release, in a terminal. A development build, an unreadable version, another surface and the short limit or quota messages Claude Code reports keep the reply exactly as written.

## What becomes a link

- Absolute paths (`C:\proj\a.ts`, `/home/me/a.ts`) and paths relative to the session's folder (`src/a.ts`), with an extension and no spaces.
- A `:line` suffix (`src/a.ts:42`) stays in the label; the link opens the file, not the line.
- Code blocks, inline code, existing links and URLs are never rewritten.
- At most 32 distinct paths per reply are checked; a reply over 64 KiB is left as written.

## Allowed extensions

The default list is in `.claude-plugin/plugin.json`. To change it, set the plugin option in your `settings.json`; it survives plugin updates and replaces the default list:

```json
{
  "pluginConfigs": {
    "mitos": {
      "options": {
        "allowed_extensions": ["md", "ts", "html"]
      }
    }
  }
}
```

The list does not appear in `/config`, because Claude Code shows no row for a list option. Claude Code also asks for it when you enable the plugin.

`exe`, `bat`, `cmd`, `ps1`, `psm1`, `msi`, `com`, `scr`, `vbs`, `hta`, `lnk`, `url`, `sh`, `reg`, `jar`, `appref-ms`, `js`, `jse`, `vbe`, `wsf`, `wsh`, `msc`, `cpl`, `pif`, `chm`, `scf`, `settingcontent-ms`, `application` and `gadget` are never linked, even when the list names them: a click hands the file to the terminal, which may run it. JavaScript files are among them, because Windows runs a `.js` file with Windows Script Host when it is opened: a `.js` path is therefore not clickable outside Kory.

## With Prosopon

Load Mitos before Prosopon. Claude Code runs the plugins in the order they are loaded, first outermost: with `--plugin-dir mitos --plugin-dir prosopon`, Mitos rewrites the text before Prosopon frames it. Loaded the other way, Prosopon frames the reply without links.
