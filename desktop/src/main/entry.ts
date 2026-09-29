// Windows resolves a bare executable name in the current directory before PATH
// (libuv, cmd.exe) unless this is set; the Deck's cwd is an untrusted clone.
process.env.NoDefaultCurrentDirectoryInExePath = '1'

// No static import: the Deck main runs module-level side effects on load, so the choice must happen first.
const main = process.argv.includes('--avatar') ? import('./avatar-entry') : import('./index')

main.catch((error: unknown) => {
  console.error('[koryphaios] cannot load the main process entry', error)
  process.exit(1)
})
