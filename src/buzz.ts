/**
 * Group coordination signals.
 *
 * Flock deliberately carries a tiny action vocabulary rather than free-form
 * chat. The fixed `reason` remains in the encrypted payload only so an older
 * client can display a signal sent by a current client; current clients derive
 * meaning from `action` and reject any non-provider-defined text.
 *
 * Encrypted with the group envelope key (`deriveGroupKey`), carried as a
 * kind-20078 signal with `t=buzz`.
 */

import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'
import {
  GROUP_COORDINATION_ACTIONS,
  coordinationActionFromLabel,
  coordinationLabel,
  isGroupCoordinationAction,
  type GroupCoordinationAction,
} from './coordination.js'

/** The `t`-tag value for buzz signals. */
export const BUZZ_SIGNAL_TYPE = 'buzz'

/** Fixed labels retained for consumers that previously rendered this export. */
export const DEFAULT_BUZZ_REASONS = GROUP_COORDINATION_ACTIONS.map(coordinationLabel)

export const RING_LOST_PHONE_ACTION = 'ring_lost_phone' as const
export const RING_LOST_PHONE_LABEL = '🔔 Ringing to find this phone' as const
export type BuzzAction = GroupCoordinationAction | typeof RING_LOST_PHONE_ACTION

const HEX_64_RE = /^[0-9a-f]{64}$/

/** A decrypted, provider-defined group signal. */
export interface Buzz {
  /** Sender pubkey (64-char hex). */
  from: string
  /** Stable protocol action. */
  action: BuzzAction
  /** Fixed compatibility label; never caller-provided prose. */
  reason: string
  /** Present only for the lost-phone ring action. */
  target?: string
  /** Unix seconds. */
  timestamp: number
  /**
   * `'location'` rides only a Check in: it asks members to report where they
   * are. Receivers decide FOR THEMSELVES how (or whether) to answer — an ask is
   * never an automatic disclosure.
   */
  ask?: 'location'
}

function labelFor(action: BuzzAction): string {
  return action === RING_LOST_PHONE_ACTION ? RING_LOST_PHONE_LABEL : coordinationLabel(action)
}

/**
 * Resolve the wire payload to a known action, or `null` if it is not one.
 *
 * Current payloads carry an explicit `action`. Older payloads carried only a
 * fixed `reason` label, so an exact (never fuzzy) label lookup migrates them.
 * Anything else — arbitrary prose, a URL, a stray whitespace variant — is not a
 * provider action and is rejected rather than displayed.
 */
function parseBuzzAction(value: unknown, compatibilityLabel: unknown): BuzzAction | null {
  if (value === RING_LOST_PHONE_ACTION || isGroupCoordinationAction(value)) return value
  if (value !== undefined) return null
  if (compatibilityLabel === RING_LOST_PHONE_LABEL) return RING_LOST_PHONE_ACTION
  const legacy = coordinationActionFromLabel(compatibilityLabel)
  return isGroupCoordinationAction(legacy) ? legacy : null
}

/**
 * Build an unsigned kind-20078 group signal, encrypted with the group envelope key.
 *
 * @throws {Error} If `from`/`target` are not valid hex pubkeys, or `action` is
 *   not a provider-defined group action (or `ring_lost_phone` with a target).
 */
export async function buildBuzzSignal(params: {
  groupId: string
  seedHex: string
  from: string
  action: BuzzAction
  target?: string
  timestamp?: number
}): Promise<UnsignedEvent> {
  if (!HEX_64_RE.test(params.from)) throw new Error('from must be a 64-character lowercase hex pubkey')
  if (params.action === RING_LOST_PHONE_ACTION) {
    if (params.target === undefined || !HEX_64_RE.test(params.target)) {
      throw new Error('ring_lost_phone requires a valid target pubkey')
    }
  } else if (!isGroupCoordinationAction(params.action)) {
    throw new Error('unknown group action')
  } else if (params.target !== undefined) {
    throw new Error('ordinary group actions cannot target one member')
  }

  const payload: Buzz = {
    from: params.from,
    action: params.action,
    reason: labelFor(params.action),
    timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
    ...(params.target !== undefined && { target: params.target }),
    ...(params.action === 'check_in' && { ask: 'location' as const }),
  }
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(payload))
  return buildSignalEvent({ groupId: params.groupId, signalType: BUZZ_SIGNAL_TYPE, encryptedContent })
}

/** Decrypt and validate a group signal, including exact-label legacy migration. */
export async function decryptBuzz(seedHex: string, content: string): Promise<Buzz> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error('Invalid buzz payload: not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid buzz payload')
  }
  const o = parsed as Record<string, unknown>
  if (typeof o.from !== 'string' || !HEX_64_RE.test(o.from)) {
    throw new Error('Invalid buzz: from must be a 64-character lowercase hex pubkey')
  }
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) {
    throw new Error('Invalid buzz: timestamp must be a number')
  }

  const action = parseBuzzAction(o.action, o.reason)
  if (!action) throw new Error('Invalid buzz: unknown action')
  const expectedLabel = labelFor(action)
  if (o.reason !== expectedLabel) throw new Error('Invalid buzz: compatibility label does not match action')

  if (action === RING_LOST_PHONE_ACTION) {
    if (typeof o.target !== 'string' || !HEX_64_RE.test(o.target)) {
      throw new Error('Invalid buzz: ring target must be a 64-character lowercase hex pubkey')
    }
    if (o.ask !== undefined) throw new Error('Invalid buzz: ring cannot carry an ask')
    return { from: o.from, action, reason: expectedLabel, target: o.target, timestamp: o.timestamp }
  }

  if (o.target !== undefined) throw new Error('Invalid buzz: ordinary group action cannot carry a target')
  if (o.ask !== undefined && o.ask !== 'location') throw new Error('Invalid buzz: unknown ask')
  if (action !== 'check_in' && o.ask !== undefined) throw new Error('Invalid buzz: only Check in can ask for location')
  return {
    from: o.from,
    action,
    reason: expectedLabel,
    timestamp: o.timestamp,
    ...(action === 'check_in' && { ask: 'location' as const }),
  }
}
