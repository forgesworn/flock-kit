import { describe, it, expect } from 'vitest'
import {
  RADAR_SESSION,
  clampTtlSec,
  requestOpen,
  supersedes,
  acceptSession,
  sessionActive,
  sessionRemainingSec,
  sessionCadenceSec,
  type SessionRequest,
  type RadarSession,
} from './radarSession'

const req = (over: Partial<SessionRequest> = {}): SessionRequest =>
  ({ requestId: 'r1', ttlSec: 900, sentAtSec: 1000, ...over })

const session = (over: Partial<RadarSession> = {}): RadarSession =>
  ({ sessionId: 'r1', ttlSec: 900, startAtSec: 1000, ...over })

describe('clampTtlSec', () => {
  it('passes a sane TTL through and caps an excessive one', () => {
    expect(clampTtlSec(900)).toBe(900)
    expect(clampTtlSec(999_999)).toBe(RADAR_SESSION.maxTtlSec)
  })

  it('nonsense takes the default — never trust the wire', () => {
    expect(clampTtlSec(0)).toBe(RADAR_SESSION.defaultTtlSec)
    expect(clampTtlSec(-5)).toBe(RADAR_SESSION.defaultTtlSec)
    expect(clampTtlSec(NaN)).toBe(RADAR_SESSION.defaultTtlSec)
  })
})

describe('requestOpen — the silent window', () => {
  it('open through its window, closed after — with skew tolerance both ways', () => {
    expect(requestOpen(req(), 1000)).toBe(true)
    expect(requestOpen(req(), 1000 + RADAR_SESSION.requestTtlSec)).toBe(true)
    expect(requestOpen(req(), 1000 + RADAR_SESSION.requestTtlSec + RADAR_SESSION.clockSkewSec)).toBe(true)
    expect(requestOpen(req(), 1000 + RADAR_SESSION.requestTtlSec + RADAR_SESSION.clockSkewSec + 1)).toBe(false)
  })

  it('a request from the near future (skew) is open; from the far future it is not', () => {
    expect(requestOpen(req(), 1000 - RADAR_SESSION.clockSkewSec)).toBe(true)
    expect(requestOpen(req(), 900)).toBe(false)
  })

  // SAFETY: there is no decline API on this module at all — the only exits are
  // acceptance and silent expiry, so "no" cannot exist on the wire.
})

describe('supersedes — asks replace, never stack', () => {
  it('anything supersedes nothing, newer supersedes older, ties keep the incumbent', () => {
    expect(supersedes(null, req())).toBe(true)
    expect(supersedes(req({ sentAtSec: 1000 }), req({ requestId: 'r2', sentAtSec: 1050 }))).toBe(true)
    expect(supersedes(req({ sentAtSec: 1050 }), req({ requestId: 'r2', sentAtSec: 1000 }))).toBe(false)
    expect(supersedes(req({ sentAtSec: 1000 }), req({ requestId: 'r2', sentAtSec: 1000 }))).toBe(false)
  })
})

describe('acceptSession', () => {
  it('an open ask becomes a live session on the acceptor clock, id preserved', () => {
    const s = acceptSession(req(), 1060)
    expect(s).toEqual({ sessionId: 'r1', ttlSec: 900, startAtSec: 1060 })
  })

  it('clamps the agreed TTL at acceptance — a hostile ask cannot buy an unbounded lift', () => {
    const s = acceptSession(req({ ttlSec: 999_999 }), 1060)
    expect(s?.ttlSec).toBe(RADAR_SESSION.maxTtlSec)
  })

  it('accepting a dead ask yields nothing — a race never resurrects consent', () => {
    expect(acceptSession(req(), 5000)).toBe(null)
  })
})

describe('sessionActive / sessionRemainingSec', () => {
  it('live through its TTL, over after (skew-tolerant)', () => {
    expect(sessionActive(session(), 1000)).toBe(true)
    expect(sessionActive(session(), 1900)).toBe(true)
    expect(sessionActive(session(), 1900 + RADAR_SESSION.clockSkewSec)).toBe(true)
    expect(sessionActive(session(), 1900 + RADAR_SESSION.clockSkewSec + 1)).toBe(false)
  })

  it('a session recorded with an over-cap TTL is still cut at the cap', () => {
    const s = session({ ttlSec: 999_999 })
    expect(sessionActive(s, 1000 + RADAR_SESSION.maxTtlSec)).toBe(true)
    expect(sessionActive(s, 1000 + RADAR_SESSION.maxTtlSec + RADAR_SESSION.clockSkewSec + 1)).toBe(false)
  })

  it('remaining counts down to 0 and never below — the pill countdown', () => {
    expect(sessionRemainingSec(session(), 1000)).toBe(900)
    expect(sessionRemainingSec(session(), 1899.5)).toBe(0) // floor, not round
    expect(sessionRemainingSec(session(), 5000)).toBe(0)
  })

  // SAFETY: the module models no end reason — expiry and an early stop are the
  // same absence of a live session, so stopping early cannot be a confession.
})

describe('sessionCadenceSec', () => {
  it('moving publishes on the floor; stationary is a keepalive, not a stream', () => {
    expect(sessionCadenceSec(true)).toBe(RADAR_SESSION.cadenceMovingSec)
    expect(sessionCadenceSec(false)).toBe(RADAR_SESSION.cadenceStationarySec)
  })
})
