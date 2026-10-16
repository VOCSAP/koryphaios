import { expect, test } from 'bun:test'
import {
  avatarBrokerProbeUrls,
  BROKER_HEALTH_MAX_BYTES,
  brokerListenerEnds,
  fetchBrokerHealth,
  brokerStopDialogOptions,
  confirmedStop,
  manualStopRefresher,
  probeBrokerUrls,
  trayBrokerSummary
} from '../desktop/src/main/avatar-broker-wiring.ts'
import { AVATAR_TRAY_COPY } from '../desktop/src/main/avatar-tray-copy.ts'

const OWN = 'http://127.0.0.1:7899'

test('the probe watches the own broker URL only when it is local or replica', () => {
  const attached = ['http://127.0.0.1:7900']
  expect(avatarBrokerProbeUrls(attached, 'local', OWN)).toEqual(['http://127.0.0.1:7900', OWN])
  expect(avatarBrokerProbeUrls(attached, 'replica', OWN)).toEqual(['http://127.0.0.1:7900', OWN])
  expect(avatarBrokerProbeUrls(attached, 'remote', OWN)).toEqual(['http://127.0.0.1:7900'])
})

test('the stop dialog defaults to and cancels on the Cancel button', () => {
  const text = AVATAR_TRAY_COPY.en.brokerStopConfirm({ url: OWN, pid: 4242, decks: 1 })
  expect(brokerStopDialogOptions(text)).toEqual({
    type: 'warning',
    title: text.title,
    message: text.message,
    detail: text.detail,
    buttons: [text.confirm, text.cancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })
})

test('only the first button, the explicit Stop, confirms the stop', () => {
  expect(confirmedStop(0)).toBe(true)
  expect(confirmedStop(1)).toBe(false)
  expect(confirmedStop(-1)).toBe(false)
})

test('the broker is looked up as the process LISTENING on 127.0.0.1:<port>', () => {
  expect(brokerListenerEnds(7899)).toEqual({
    local: { address: '127.0.0.1', port: 7899 },
    remote: { address: '0.0.0.0', port: 0 }
  })
})

test('the tray summary and the probe both re-read the manual stop before they run', () => {
  const calls: string[] = []
  const refresh = (): void => void calls.push('refresh')

  expect(trayBrokerSummary(refresh, () => {
    calls.push('summary')
    return 'S'
  })()).toBe('S')
  expect(probeBrokerUrls(refresh, () => {
    calls.push('urls')
    return [OWN]
  })()).toEqual([OWN])

  expect(calls).toEqual(['refresh', 'summary', 'refresh', 'urls'])
})

test('/health is asked on 127.0.0.1 at the inspected port, never following a redirect', async () => {
  const asked: Array<{ url: string; redirect: unknown }> = []
  const body = await fetchBrokerHealth(7899, async (url, init) => {
    asked.push({ url: String(url), redirect: init?.redirect })
    return new Response(JSON.stringify({ status: 'ok' }))
  })

  expect(body).toEqual({ status: 'ok' })
  expect(asked).toEqual([{ url: 'http://127.0.0.1:7899/health', redirect: 'error' }])
})

test('a /health answer over the size cap is refused, announced or streamed', async () => {
  const big = 'x'.repeat(BROKER_HEALTH_MAX_BYTES + 1)
  const announced = new Response('{}', { headers: { 'content-length': String(BROKER_HEALTH_MAX_BYTES + 1) } })
  const streamed = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`{"pad":"${big}"}`))
      controller.close()
    }
  }))

  await expect(fetchBrokerHealth(7899, async () => announced)).rejects.toThrow('bytes')
  await expect(fetchBrokerHealth(7899, async () => streamed)).rejects.toThrow('bytes')
})

test('a non-2xx or non-JSON /health is refused', async () => {
  await expect(fetchBrokerHealth(7899, async () => new Response('{}', { status: 503 }))).rejects.toThrow('503')
  await expect(fetchBrokerHealth(7899, async () => new Response('<html>'))).rejects.toThrow()
})

test('the manual stop is applied on every read and republished only when it changes', () => {
  let stopped = false
  const applied: boolean[] = []
  let republished = 0
  const refresh = manualStopRefresher(() => stopped, (value) => applied.push(value), () => { republished += 1 })

  refresh()
  refresh()
  stopped = true
  refresh()
  refresh()
  stopped = false
  refresh()

  expect(applied).toEqual([false, false, true, true, false])
  expect(republished).toBe(2)
})
