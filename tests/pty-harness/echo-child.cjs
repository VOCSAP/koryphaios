// Child half of the ConPTY coalescing probe (card 6168b7f4).
//
// Sits in a pty, puts stdin in raw mode, and prints ONE line per read with the
// exact byte length of that read. That length is the whole point: Claude Code's
// tokenizer decides whether a control byte becomes its own token (hence a
// `return` key that SUBMITS) from the size of the read that carries it, so the
// question "did these two writes arrive as one read or two?" is the mechanism.
//
// Plain Node, no dependencies: it is spawned INSIDE the pty by coalescing-probe.js.
process.stdout.write('READY\n')
if (process.stdin.setRawMode) process.stdin.setRawMode(true)
process.stdin.on('data', (b) => {
  process.stdout.write('CHUNK len=' + b.length + ' ' + JSON.stringify(b.toString('utf8')) + '\n')
})
setTimeout(() => process.exit(0), 15000)
