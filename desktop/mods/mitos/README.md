# Mitos

Mitos turns the file and folder paths of an assistant reply into clickable `file:///` links. A path is linked only when it names an existing file with an allowed extension, or an existing folder without an extension, reached through no symbolic link or junction. Claude Code then draws the link as a terminal hyperlink (OSC 8), which a terminal that supports them opens on click; a folder opens in the file manager.

## Install

```text
/plugin install mitos@choregos
```

Mitos runs on Claude Code `2.1.303` or any later release, in a terminal. A development build, an unreadable version, another surface and the short limit or quota messages Claude Code reports keep the reply exactly as written.

## What becomes a link

- Absolute file paths (`C:\proj\a.ts`, `/home/me/a.ts`) and file paths relative to the session's folder (`src/a.ts`), with an extension and no spaces. An extension follows a dot that does not open the name: a file named `md` or `.md` has none and stays as written.
- Folders without an extension, written absolute (`C:\proj\src`, `/home/me/src`) or ending with a separator (`src/`). A relative name without a final separator (`src`) stays as written. A folder whose name has an extension (`lib.d/`, `Evil.app/`, `Setup.pkg\`) is never linked, since opening a bundle runs it; a leading dot is not an extension, so `.claude/` is linked.
- A `:line` suffix (`src/a.ts:42`) stays in the label; the link opens the file, not the line.
- Inline code whose whole content is one such path (`` `src/a.ts` ``) becomes a link as a whole, backticks kept. Inline code holding anything else, such as a command or a path with other words, stays as written.
- Code blocks, existing links and URLs are never rewritten.
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
