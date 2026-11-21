import { describe, expect, it } from 'vitest'
import { circleIdentity, circleStateCommitment, decideCircleTransition, parseCircleState, type CircleStatePacket } from './circleLifecycle.js'

const owner = 'a'.repeat(64)
const retained = 'b'.repeat(64)
const removed = 'c'.repeat(64)
const salt = 'd'.repeat(64)
const start: CircleStatePacket = {
  t: 'flock-circle-state-v2', id: await circleIdentity(owner, salt), owner, salt,
  name: 'Friends', expiresAt: 0, epoch: 0, parent: null, seed: '1'.repeat(64),
  members: [owner, retained, removed], removed: [], at: 1000,
}
const rotation: CircleStatePacket = {
  ...start, epoch: 1, parent: await circleStateCommitment(start), seed: '2'.repeat(64),
  members: [owner, retained], removed: [removed], at: 1001,
}

describe('authorised circle lifecycle', () => {
  it('accepts a retained recipient and requires the recorded owner', async () => {
    expect(await decideCircleTransition(start, rotation, owner, retained, 1001)).toBe('accept')
    expect(await decideCircleTransition(start, rotation, retained, retained, 1001)).toBe('reject')
    expect(await decideCircleTransition(start, rotation, owner, removed, 1001)).toBe('reject')
  })

  it('binds an adjacent rotation to the predecessor and rejects replay', async () => {
    expect(await decideCircleTransition(start, { ...rotation, parent: 'f'.repeat(64) }, owner, retained, 1001)).toBe('reject')
    expect(await decideCircleTransition(rotation, start, owner, retained, 1001)).toBe('reject')
    expect(await decideCircleTransition(rotation, rotation, owner, retained, 1001)).toBe('duplicate')
  })

  it('pauses on a conflicting authorised state at the same epoch', async () => {
    expect(await decideCircleTransition(rotation, { ...rotation, seed: '3'.repeat(64) }, owner, retained, 1001)).toBe('conflict')
  })

  it('accepts an owner-authenticated catch-up snapshot with cumulative removals', async () => {
    const next = { ...rotation, epoch: 3, parent: 'f'.repeat(64), seed: '4'.repeat(64), at: 1003 }
    expect(await decideCircleTransition(start, next, owner, retained, 1003)).toBe('accept')
    expect(await decideCircleTransition(rotation, { ...next, removed: [] }, owner, retained, 1003)).toBe('reject')
  })

  it('requires a new seed when removing a member and validates terminal changes', async () => {
    expect(await decideCircleTransition(start, { ...rotation, seed: start.seed }, owner, retained, 1001)).toBe('reject')
    const closed = { ...rotation, seed: null }
    expect(await decideCircleTransition(start, closed, owner, retained, 1001)).toBe('accept')
    expect(await decideCircleTransition(start, closed, retained, retained, 1001)).toBe('reject')
    expect(await decideCircleTransition(closed, rotation, owner, retained, 1001)).toBe('reject')
  })

  it('rejects malformed or contradictory membership and expired circles', async () => {
    expect(parseCircleState({ ...rotation, members: [owner, owner] })).toBeNull()
    expect(parseCircleState({ ...rotation, members: [owner, removed] })).toBeNull()
    expect(await decideCircleTransition(start, { ...rotation, expiresAt: 1001 }, owner, retained, 1001)).toBe('reject')
    expect(await decideCircleTransition(null, { ...rotation, id: 'f'.repeat(64) }, owner, retained, 1001)).toBe('reject')
  })
})
