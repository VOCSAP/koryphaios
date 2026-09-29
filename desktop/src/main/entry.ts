// No static import: the Deck main runs module-level side effects on load, so the choice must happen first.
const main = process.argv.includes('--avatar') ? import('./avatar-entry') : import('./index')

main.catch((error: unknown) => {
  console.error('[koryphaios] cannot load the main process entry', error)
  process.exit(1)
})
