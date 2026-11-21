// Owner-authorised circle state. Pass the authenticated NIP-59 seal signer to
// the transition check. The caller handles persistence, clocks and transport.

export interface CircleStatePacket {
  t: 'flock-circle-state-v2'
  id: string
  owner: string
  salt: string
  name: string
  expiresAt: number
  epoch: number
  parent: string | null
  /** A terminal update carries no access secret. */
  seed: string | null
  members: string[]
  removed: string[]
  /** The signed epoch of each explicit re-admission. */
  readmitted?: Record<string, number>
  at: number
}

const hex = /^[a-f0-9]{64}$/
const isHex = (value: unknown): value is string => typeof value === 'string' && hex.test(value)
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const encoder = new TextEncoder()
const clockSkewSec = 120

async function commitment(fields: readonly unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(fields)))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function circleIdentity(owner: string, salt: string): Promise<string> {
  return commitment(['flock/circle/v2', owner, salt])
}

export function circleStateCommitment(state: CircleStatePacket): Promise<string> {
  return commitment(['flock/circle-state/v2', state.id, state.epoch, state.parent, state.seed,
    [...state.members].sort(), [...state.removed].sort(), state.name, state.expiresAt, state.at,
    Object.entries(state.readmitted ?? {}).sort(([a], [b]) => a.localeCompare(b, 'en'))])
}

function roster(values: unknown): string[] | null {
  if (!Array.isArray(values) || values.length > 512 || !values.every(isHex)) return null
  return new Set(values).size === values.length ? [...values].sort() : null
}

export function parseCircleState(value: unknown): CircleStatePacket | null {
  if (typeof value !== 'object' || !value) return null
  const o = value as Record<string, unknown>
  if (o.t !== 'flock-circle-state-v2' || !isHex(o.id) || !isHex(o.owner) || !isHex(o.salt) ||
      typeof o.name !== 'string' || !o.name.trim() || o.name.length > 256 ||
      !counter(o.expiresAt) || !counter(o.epoch) || !counter(o.at) || !o.at ||
      (o.epoch === 0 ? o.parent !== null : !isHex(o.parent)) ||
      (o.seed !== null && !isHex(o.seed))) return null
  const members = roster(o.members)
  const removed = roster(o.removed)
  if (!members || !removed || members.length + removed.length > 512 || !members.includes(o.owner) || members.some((pk) => removed.includes(pk))) return null
  let readmitted: Record<string, number> | undefined
  if (o.readmitted !== undefined) {
    if (!o.readmitted || typeof o.readmitted !== 'object' || Array.isArray(o.readmitted)) return null
    const entries = Object.entries(o.readmitted)
    if (entries.some(([pk, epoch]) => (!members.includes(pk) && !removed.includes(pk)) || !counter(epoch) || epoch === 0 || epoch > (o.epoch as number))) return null
    readmitted = Object.fromEntries(entries)
  }
  return {
    t: o.t, id: o.id, owner: o.owner, salt: o.salt, name: o.name, expiresAt: o.expiresAt,
    epoch: o.epoch, parent: o.parent as string | null, seed: o.seed, members, removed, at: o.at,
    ...(readmitted && Object.keys(readmitted).length ? { readmitted } : {}),
  }
}

export type TransitionDecision = 'accept' | 'reject' | 'duplicate' | 'conflict'

/** Same-epoch conflicts pause the circle. An authenticated later snapshot may
 *  catch up a retained device across missed epochs. A terminal state is final. */
export async function decideCircleTransition(
  held: CircleStatePacket | null, offered: CircleStatePacket, actor: string, recipient: string, now: number,
): Promise<TransitionDecision> {
  const next = parseCircleState(offered)
  if (!next || actor !== next.owner || !next.members.includes(recipient) ||
      next.at > now + clockSkewSec || (next.expiresAt > 0 && next.expiresAt <= now) ||
      await circleIdentity(next.owner, next.salt) !== next.id) return 'reject'
  if (!held) return next.seed === null ? 'reject' : 'accept'
  if (next.id !== held.id || next.owner !== held.owner || next.salt !== held.salt ||
      next.expiresAt !== held.expiresAt || held.seed === null || next.epoch < held.epoch) return 'reject'
  if (next.epoch === held.epoch) {
    return await circleStateCommitment(next) === await circleStateCommitment(held) ? 'duplicate' : 'conflict'
  }
  const reinstated = (pk: string): boolean => (next.readmitted?.[pk] ?? 0) > held.epoch
  if (held.removed.some((pk) => !next.removed.includes(pk) && (!next.members.includes(pk) || !reinstated(pk))) ||
      held.members.some((pk) => !next.members.includes(pk) && !next.removed.includes(pk))) return 'reject'
  if (Object.entries(held.readmitted ?? {}).some(([pk, epoch]) => (next.readmitted?.[pk] ?? 0) < epoch)) return 'reject'
  if (next.seed === held.seed && (next.removed.some((pk) => !held.removed.includes(pk)) || Object.keys(next.readmitted ?? {}).some(reinstated))) return 'reject'
  if (next.epoch === held.epoch + 1 && next.parent !== await circleStateCommitment(held)) return 'reject'
  return 'accept'
}
