import type { PeerTelemetrySnapshot } from '../../../shared/peer-telemetry'

type TileTelemetryAction =
  | { action: 'publish'; snapshot: PeerTelemetrySnapshot }
  | { action: 'stop' }

export type TileTelemetryDraft = {
  deskSession: string
  launchHash: string
} & TileTelemetryAction

export interface TileTelemetryPublisherDeps {
  send(draft: TileTelemetryDraft): Promise<void>
  report(message: string, error: unknown): void
}

interface LaunchState {
  deskSession: string
  launchHash: string
  inFlight: boolean
  stopping: boolean
  stopSent: boolean
  reported: boolean
  resolve: () => void
  settled: Promise<void>
}

export class TileTelemetryPublisher {
  private launches = new Map<string, LaunchState>()
  private inFlight = new Set<string>()

  constructor(private deps: TileTelemetryPublisherDeps) {}

  start(deskSession: string, launchHash: string): void {
    this.launches.set(deskSession, this.createLaunch(deskSession, launchHash))
  }

  publish(deskSession: string, snapshot: PeerTelemetrySnapshot): void {
    const launch = this.launches.get(deskSession)
    if (!launch || this.inFlight.has(deskSession) || launch.stopping) return
    this.send(launch, { action: 'publish', snapshot })
  }

  stop(deskSession: string): Promise<void> {
    const launch = this.launches.get(deskSession)
    if (!launch) return Promise.resolve()
    launch.stopping = true
    if (!launch.inFlight && !launch.stopSent) this.sendStop(launch)
    return launch.settled
  }

  close(): Promise<void> {
    return Promise.all([...this.launches.keys()].map((deskSession) => this.stop(deskSession))).then(() => undefined)
  }

  private createLaunch(deskSession: string, launchHash: string): LaunchState {
    let resolve!: () => void
    const settled = new Promise<void>((done) => {
      resolve = done
    })
    return { deskSession, launchHash, inFlight: false, stopping: false, stopSent: false, reported: false, resolve, settled }
  }

  private sendStop(launch: LaunchState): void {
    launch.stopSent = true
    this.send(launch, { action: 'stop' })
  }

  private send(launch: LaunchState, draft: TileTelemetryAction): void {
    launch.inFlight = true
    this.inFlight.add(launch.deskSession)
    void this.deps.send({ deskSession: launch.deskSession, launchHash: launch.launchHash, ...draft }).then(() => {
      launch.reported = false
    }, (error: unknown) => {
      if (launch.reported && draft.action === 'publish') return
      launch.reported = true
      this.deps.report(`tile telemetry ${draft.action} failed for ${launch.deskSession}`, error)
    }).finally(() => {
      launch.inFlight = false
      if (launch.stopping && !launch.stopSent) {
        this.sendStop(launch)
        return
      }
      if (launch.stopSent) {
        this.inFlight.delete(launch.deskSession)
        if (this.launches.get(launch.deskSession) === launch) this.launches.delete(launch.deskSession)
        launch.resolve()
        return
      }
      this.inFlight.delete(launch.deskSession)
    })
  }
}
