const { createServer } = require('node:https')
const { WebSocketServer } = require(process.argv[4])
const { generate } = require(process.argv[5])
const { requestAvatarHttps, connectAvatarWss } = require(process.argv[2])
const { generateAvatarRunCertificate } = require(process.argv[3])

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing loopback port')
      resolve(address.port)
    })
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

function requestCompletes(rendezvous) {
  return new Promise((resolve, reject) => {
    const request = requestAvatarHttps(rendezvous, '/', (response) => {
      response.resume()
      response.once('end', resolve)
    })
    request.once('error', reject)
    request.end()
  })
}

async function rejects(request) {
  try {
    await request()
    return false
  } catch {
    return true
  }
}

function wssCompletes(rendezvous) {
  return new Promise((resolve, reject) => {
    const socket = connectAvatarWss(rendezvous, '/')
    socket.once('open', () => socket.close())
    socket.once('close', resolve)
    socket.once('error', reject)
  })
}

async function run() {
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') {
    throw new Error('Avatar transport fixture must run in Electron Node mode')
  }
  const runCertificate = await generateAvatarRunCertificate()
  const signedLeaf = await generate(
    [{ name: 'commonName', value: 'kory-avatar-signed-leaf' }],
    {
      keySize: 2048,
      algorithm: 'sha256',
      ca: { key: runCertificate.keyPem, cert: runCertificate.certPem },
      extensions: [{ name: 'subjectAltName', critical: false, altNames: [{ type: 7, ip: '127.0.0.1' }] }]
    }
  )
  let httpsBearer = false
  let signedLeafHttpsRequests = 0
  let wssBearer = false
  let signedLeafWssUpgrades = 0
  const trustedHttps = createServer({ key: runCertificate.keyPem, cert: runCertificate.certPem }, (request, response) => {
    httpsBearer = request.headers.authorization === 'Bearer avatar-test-token'
    response.end('ok')
  })
  const signedLeafHttps = createServer({ key: signedLeaf.private, cert: signedLeaf.cert }, (_request, response) => {
    signedLeafHttpsRequests += 1
    response.end('unexpected')
  })
  const trustedWssServer = createServer({ key: runCertificate.keyPem, cert: runCertificate.certPem })
  const signedLeafWssServer = createServer({ key: signedLeaf.private, cert: signedLeaf.cert })
  const trustedWss = new WebSocketServer({ server: trustedWssServer })
  new WebSocketServer({ server: signedLeafWssServer })
  trustedWss.on('connection', (socket, request) => {
    wssBearer = request.headers.authorization === 'Bearer avatar-test-token'
    socket.close()
  })
  signedLeafWssServer.on('upgrade', () => {
    signedLeafWssUpgrades += 1
  })

  const servers = [trustedHttps, signedLeafHttps, trustedWssServer, signedLeafWssServer]
  try {
    const [trustedHttpsPort, signedLeafHttpsPort, trustedWssPort, signedLeafWssPort] = await Promise.all(servers.map(listen))
    const rendezvous = (port) => ({
      version: 1,
      avatarRunId: 'avatar-electron-test',
      pid: process.pid,
      port,
      certPem: runCertificate.certPem,
      token: 'avatar-test-token'
    })
    await requestCompletes(rendezvous(trustedHttpsPort))
    const signedLeafHttpsRejected = await rejects(() => requestCompletes(rendezvous(signedLeafHttpsPort)))
    await wssCompletes(rendezvous(trustedWssPort))
    const signedLeafWssRejected = await rejects(() => wssCompletes(rendezvous(signedLeafWssPort)))
    const result = {
      httpsBearer,
      signedLeafHttpsRejected,
      signedLeafHttpsRequests,
      wssBearer,
      signedLeafWssRejected,
      signedLeafWssUpgrades
    }
    if (
      !result.httpsBearer ||
      !result.signedLeafHttpsRejected ||
      result.signedLeafHttpsRequests !== 0 ||
      !result.wssBearer ||
      !result.signedLeafWssRejected ||
      result.signedLeafWssUpgrades !== 0
    ) {
      throw new Error(JSON.stringify(result))
    }
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    trustedWss.close()
    await Promise.all(servers.map(close))
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
