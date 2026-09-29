const { request } = require('node:https')
const { deckSocketEndpoints, startAvatarServer } = require(process.argv[2])
const { createAvatarClient, postAvatarJson } = require(process.argv[3])
const { connectAvatarWss } = require(process.argv[4])
const { generateAvatarRunCertificate } = require(process.argv[5])
const { AvatarState } = require(process.argv[6])
const { loopbackSocketOwner, runSocketOwnerHelper } = require(process.argv[7])

const deck = {
  deckRunId: 'deck-run-e2e',
  deckPid: process.pid,
  broker_url: 'http://127.0.0.1:7899',
  projectDir: process.cwd(),
  deckName: 'E2E'
}

function unattachedBindCloseCode(rendezvous) {
  return new Promise((resolve, reject) => {
    const socket = connectAvatarWss(rendezvous, '/ws')
    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'bind', protocol_version: 1, deckRunId: 'deck-run-unattached', broker_url: deck.broker_url }))
    })
    socket.once('close', (code) => resolve(code))
    socket.once('error', reject)
  })
}

function upgradeOutcome(port, path, headers) {
  return new Promise((resolve) => {
    const outgoing = request({
      host: '127.0.0.1',
      port,
      path,
      rejectUnauthorized: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers
      }
    })
    outgoing.on('upgrade', (_response, socket) => {
      socket.destroy()
      resolve('upgraded')
    })
    outgoing.on('response', (response) => resolve(`response ${response.statusCode}`))
    outgoing.on('error', () => resolve('destroyed'))
    outgoing.end()
  })
}

function oversizedFrameCloseCode(rendezvous) {
  return new Promise((resolve, reject) => {
    const socket = connectAvatarWss(rendezvous, '/ws')
    socket.once('open', () => socket.send('x'.repeat(64 * 1024 + 1)))
    socket.once('close', (code) => resolve(code))
    socket.once('error', reject)
  })
}

async function detachedCloseCode(rendezvous, postAvatarJson) {
  const other = { ...deck, deckRunId: 'deck-run-detached' }
  const identity = { deckRunId: other.deckRunId, broker_url: other.broker_url }
  if ((await postAvatarJson(rendezvous, '/attach', { protocol_version: 1, ...other })) !== 200) throw new Error('attach refused')
  const socket = connectAvatarWss(rendezvous, '/ws')
  const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)))
  await new Promise((resolve, reject) => {
    socket.once('open', () => socket.send(JSON.stringify({ type: 'bind', protocol_version: 1, ...identity })))
    socket.once('message', resolve)
    socket.once('error', reject)
  })
  if ((await postAvatarJson(rendezvous, '/detach', identity)) !== 200) throw new Error('detach refused')
  return closed
}

/** The server reads the Deck-side port on the real upgraded socket, and netstat names this process as its owner. */
async function boundSocketEnds(rendezvous, server, postAvatarJson) {
  const other = { ...deck, deckRunId: 'deck-run-port' }
  const identity = { deckRunId: other.deckRunId, broker_url: other.broker_url }
  if ((await postAvatarJson(rendezvous, '/attach', { protocol_version: 1, ...other })) !== 200) throw new Error('attach refused')
  const socket = connectAvatarWss(rendezvous, '/ws')
  const closed = new Promise((resolve) => socket.once('close', resolve))
  await new Promise((resolve, reject) => {
    socket.once('open', () => socket.send(JSON.stringify({ type: 'bind', protocol_version: 1, ...identity })))
    socket.once('message', resolve)
    socket.once('error', reject)
  })
  const clientPort = socket._socket.localPort
  const ends = deckSocketEndpoints(server, identity)
  const owner =
    process.platform === 'win32'
      ? (await loopbackSocketOwner(ends.local, ends.remote, { env: process.env, run: runSocketOwnerHelper })) === process.pid
      : 'not windows'
  const result = {
    boundPortIsClientPort: server.boundRemotePort(identity) === clientPort,
    localEndIsClient: ends.local.port === clientPort,
    remoteEndIsServer: ends.remote.port === server.port,
    ownerIsThisProcess: owner
  }
  if ((await postAvatarJson(rendezvous, '/detach', identity)) !== 200) throw new Error('detach refused')
  await closed
  return result
}

async function focusOnceBound(server) {
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      return await server.focusDeck({ deckRunId: deck.deckRunId, broker_url: deck.broker_url })
    } catch (error) {
      const notReady = error.message === 'Avatar Deck is not attached' || error.message === 'Avatar Deck is not bound'
      if (!notReady || Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}

async function run() {
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') {
    throw new Error('Avatar WSS fixture must run in Electron Node mode')
  }
  const certificate = await generateAvatarRunCertificate()
  const reports = []
  const report = (scope, message) => reports.push(`${scope}: ${message}`)
  const server = await startAvatarServer({
    avatarRunId: 'avatar-run-e2e',
    certificate,
    state: new AvatarState({ now: () => Date.now() }),
    token: 'avatar-e2e-token',
    report
  })
  const rendezvous = {
    version: 1,
    avatarRunId: 'avatar-run-e2e',
    pid: process.pid,
    port: server.port,
    certPem: certificate.certPem,
    token: 'avatar-e2e-token'
  }
  let focused = 0
  const client = createAvatarClient({
    deck: () => deck,
    autoAttachEnabled: () => true,
    rendezvous: () => rendezvous,
    sessions: () => [],
    focus: async () => {
      focused += 1
    },
    report
  })
  try {
    const closeCode = await unattachedBindCloseCode(rendezvous)
    const bearer = { Authorization: `Bearer ${rendezvous.token}` }
    const upgrades = {
      wrongRoute: await upgradeOutcome(server.port, '/other', bearer),
      withOrigin: await upgradeOutcome(server.port, '/ws', { ...bearer, Origin: 'https://example.test' }),
      wrongBearer: await upgradeOutcome(server.port, '/ws', { Authorization: 'Bearer wrong-token' })
    }
    const oversizedCloseCode = await oversizedFrameCloseCode(rendezvous)
    const detachCloseCode = await detachedCloseCode(rendezvous, postAvatarJson)
    const socketEnds = await boundSocketEnds(rendezvous, server, postAvatarJson)
    client.start()
    const focus = await focusOnceBound(server)
    const attachedBeforeStop = server.attachedDecks().length
    await client.stop()
    const result = {
      unattachedBindCloseCode: closeCode,
      upgrades,
      oversizedCloseCode,
      detachCloseCode,
      socketEnds,
      focusOk: focus.ok,
      focused,
      attachedBeforeStop,
      attachedAfterStop: server.attachedDecks().length,
      reports
    }
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    await client.stop()
    await server.close()
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
