import {
  ConnectionState,
  RoomEvent,
  type ReconnectContext,
  type ReconnectPolicy,
  type Room,
} from 'livekit-client'
import type { ApiConfig } from '@/api/useConfig'

/**
 * Until the first attempt of a reconnection starts, the room still reports
 * Connected and LiveKit keeps checking its transport: 8 to 12 s after the
 * drop, it turns the resume it was about to try into a full reconnection.
 * The first attempt starts well before that.
 */
export const MAX_FIRST_DELAY_MS = 5_000

// setTimeout fires immediately for longer delays
const MAX_TIMEOUT_MS = 2 ** 31 - 1

// Bounds the doubling: past it any sensible cap applies anyway, and the
// product stays a finite number
const MAX_EXPONENT = 30

export type ReconnectBackoffConfig = {
  baseDelayMs: number
  maxDelayMs: number
  giveUpAfterMs: number
  backoffResetMs: number
}

type Reconnection = {
  startedAt: number
  // Higher than 0 when the previous reconnection ended shortly before
  firstStep: number
  failedAttempts: number
  isMediaLost: boolean
}

/**
 * When LiveKit restarts or Redis stalls, every client loses its signal
 * connection at the same time. This policy implements an exponential backoff
 * with some randomness to spread the reconnections out.
 *
 * The policy keeps its own clock since LiveKit calls the policy again on every
 * new disconnection trigger
 */
export class BackoffReconnectPolicy implements ReconnectPolicy {
  private readonly config: ReconnectBackoffConfig
  private readonly random: () => number
  private readonly now: () => number
  private room: Room | undefined
  private reconnection: Reconnection | undefined
  private lastRecovery: { at: number; step: number } | undefined
  private hasGivenUp = false
  private lastReconnectionDuration: number | undefined

  constructor(
    config: ReconnectBackoffConfig,
    {
      random = Math.random,
      now = () => performance.now(),
    }: { random?: () => number; now?: () => number } = {}
  ) {
    this.config = config
    this.random = random
    this.now = now
  }

  attach(room: Room) {
    this.room = room
    room.on(RoomEvent.Connected, this.handleRecovery)
    room.on(RoomEvent.Reconnected, this.handleRecovery)
    room.on(RoomEvent.Reconnecting, this.handleMediaLost)
    room.on(RoomEvent.ConnectionStateChanged, this.handleStateChange)
  }

  /** Whether the room was disconnected because the policy gave up. */
  get gaveUp() {
    return this.hasGivenUp
  }

  /** How long the reconnection ended by the latest recovery lasted. */
  get lastReconnectionDurationMs() {
    return this.lastReconnectionDuration
  }

  nextRetryDelayInMs({ retryCount }: ReconnectContext): number | null {
    try {
      return this.computeDelay(retryCount)
    } catch {
      return Math.floor(Math.random() * MAX_FIRST_DELAY_MS)
    }
  }

  private computeDelay(retryCount: number): number | null {
    const now = this.now()
    this.reconnection ??= this.startReconnection(now)
    const reconnection = this.reconnection
    // Never step the backoff down within a reconnection: when the server
    // asks the client to reconnect, LiveKit calls the policy again with a
    // retry count of 0
    reconnection.failedAttempts = Math.max(
      reconnection.failedAttempts,
      retryCount || 0
    )

    // While only the signaling is reconnecting, the call can still carry
    // audio and video: keep trying. Each resume attempt switches the room
    // back to SignalReconnecting, even once the peer connections failed, so
    // the reconnection remembers that it went through Reconnecting
    const isMediaUp =
      this.room?.state === ConnectionState.SignalReconnecting &&
      !reconnection.isMediaLost
    if (
      now - reconnection.startedAt >= this.config.giveUpAfterMs &&
      !isMediaUp
    ) {
      this.hasGivenUp = true
      return null
    }

    const step = Math.min(
      reconnection.firstStep + reconnection.failedAttempts,
      MAX_EXPONENT
    )
    let ceiling = Math.min(
      this.config.maxDelayMs,
      this.config.baseDelayMs * 2 ** step
    )
    if (reconnection.failedAttempts === 0) {
      // LiveKit restarts its timer on every new trigger: count from the drop
      const timeLeft = reconnection.startedAt + MAX_FIRST_DELAY_MS - now
      ceiling = Math.min(ceiling, Math.max(timeLeft, 0))
    }
    return Math.min(Math.floor(this.random() * ceiling), MAX_TIMEOUT_MS)
  }

  private startReconnection(now: number): Reconnection {
    const recovery = this.lastRecovery
    // A new reconnection shortly after the last one picks up its backoff
    const isRecent =
      recovery !== undefined && now - recovery.at < this.config.backoffResetMs
    return {
      startedAt: now,
      firstStep: isRecent ? recovery.step + 1 : 0,
      failedAttempts: 0,
      isMediaLost: false,
    }
  }

  // LiveKit only switches the room to Reconnecting once its peer connections
  // failed or were torn down
  private handleMediaLost = () => {
    this.reconnection ??= this.startReconnection(this.now())
    this.reconnection.isMediaLost = true
  }

  private handleStateChange = (state: ConnectionState) => {
    if (state !== ConnectionState.Connecting) return
    // A new join replaces any reconnection in progress: what follows is a new
    // reconnection, not the continuation of the old one
    this.reconnection = undefined
    this.hasGivenUp = false
  }

  private handleRecovery = () => {
    const now = this.now()
    if (this.reconnection) {
      const { startedAt, firstStep, failedAttempts } = this.reconnection
      this.lastRecovery = { at: now, step: firstStep + failedAttempts }
      this.lastReconnectionDuration = now - startedAt
      this.reconnection = undefined
    } else {
      // LiveKit can emit Reconnected several times for a full reconnection
      // We want to avoid duplicating the reconnection duration in PostHog
      this.lastReconnectionDuration = undefined
    }
    this.hasGivenUp = false
  }
}

type ApiReconnectConfig = NonNullable<ApiConfig['livekit']['reconnect']>

const isDelay = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

// A base or max delay of 0 removes the jitter, a give-up delay of 0 ends the
// call at the first drop
const isNonZeroDelay = (value: unknown): value is number =>
  isDelay(value) && value > 0

/**
 * Build the policy from the config endpoint. Return undefined, to keep
 * LiveKit's default policy, when the backend sends no reconnect settings,
 * disables the backoff, or sends an unusable value.
 */
export const createReconnectPolicy = (
  config: Partial<ApiReconnectConfig>
): BackoffReconnectPolicy | undefined => {
  const {
    backoff_enabled,
    base_delay_ms,
    max_delay_ms,
    give_up_after_ms,
    backoff_reset_ms,
  } = config
  if (
    !backoff_enabled ||
    !isNonZeroDelay(base_delay_ms) ||
    !isNonZeroDelay(max_delay_ms) ||
    !isNonZeroDelay(give_up_after_ms) ||
    !isDelay(backoff_reset_ms)
  ) {
    return
  }
  return new BackoffReconnectPolicy({
    baseDelayMs: base_delay_ms,
    maxDelayMs: max_delay_ms,
    giveUpAfterMs: give_up_after_ms,
    backoffResetMs: backoff_reset_ms,
  })
}
