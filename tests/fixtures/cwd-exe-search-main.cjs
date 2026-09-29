// Stand-in for the Deck and avatar mains: reports whether a bare name resolves
// to the binary planted in KORY_TRAP_DIR, through execFile and through cmd.exe.
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const cwd = process.env.KORY_TRAP_DIR
const run = (file, args) => {
  try {
    return execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    return `refused:${error.code ?? error.status}`
  }
}
const cmd = join(process.env.SystemRoot, 'Sys' + 'tem32', 'cmd.exe')
process.stdout.write(
  JSON.stringify({
    execFile: run('kory-trap-probe', ['--version']),
    cmdShell: run(cmd, ['/d', '/c', 'kory-trap-probe --version'])
  })
)
