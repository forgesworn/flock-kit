/**
 * Radar session — the pure rules for a consented, time-boxed cadence lift.
 *
 * A session is a MUTUAL agreement between exactly two members that, briefly,
 * both publish Exact-precision beacons on a session cadence — so an active
 * approach feels live instead of frozen between cell-gated disclosures. See
 * docs/plans/2026-07-21-radar-session-design.md (flock repo) for the consent
 * flow and coercion analysis this module encodes.
 *
 * The consent properties live HERE, not in DOM code:
 *  - an unanswered request simply stops being open ({@link requestOpen}) — the
 *    module models no decline, so a "no" cannot exist on the wire and ignoring
 *    is indistinguishable from never seeing it;
 *  - a session ends by expiry or stop and the module models NO end reason —
 *    stopping early must read exactly like running out of time;
 *  - TTLs are clamped ({@link clampTtlSec}) so a malicious or buggy peer can
 *    never ask for, or grant, an unbounded session;
 *  - the cadence helpers say how OFTEN to publish, never WHAT — precision
 *    posture ceilings and no-report zones are enforced by the existing policy
 *    layer, which a session must never bypass.
 *
 * Pure, synchronous, deterministic — no I/O, no Date.now(), no mutation.
 * "Now" is always an input, exactly as in `radar.ts`.
 */

/** Tuning constants — exported so the UI, publishers and tests share one vocabulary. */
export const RADAR_SESSION = {
  /** An unanswered ask stops being open after this — silently, on both ends. */
  requestTtlSec: 120,
  /** The TTL a request proposes when the asker expresses no preference. */
  defaultTtlSec: 900,
  /** No request or session may exceed this, whatever the wire says. */
  maxTtlSec: 3600,
  /** Session beacon floor while the publisher is moving. */
  cadenceMovingSec: 5,
  /** …and while stationary (a keepalive, not a stream). */
  cadenceStationarySec: 30,
  /** Tolerated clock skew between the two devices' ideas of "now". */
  clockSkewSec: 30,
} as const

export type RadarSessionOptions = typeof RADAR_SESSION

/** An ask, as either end sees it. `sentAtSec` is the SENDER's clock. */
export interface SessionRequest {
  /** Caller-generated id; the accepted session reuses it, pairing the two. */
  requestId: string
  /** Proposed session length. Clamped on read — never trust the wire. */
  ttlSec: number
  sentAtSec: number
}

/** A live session, as either end sees it. */
export interface RadarSession {
  /** The `requestId` it was accepted from. */
  sessionId: string
  /** Agreed session length, already clamped at acceptance. */
  ttlSec: number
  /** The ACCEPTOR's clock at acceptance — both ends adopt it from the accept
   *  signal, so the two countdowns agree to within transport delay. */
  startAtSec: number
}

/** Clamp a proposed TTL to (0, maxTtlSec]; nonsense (NaN, ≤0) takes the default. */
export function clampTtlSec(ttlSec: number, opts: RadarSessionOptions = RADAR_SESSION): number {
  if (typeof ttlSec !== 'number' || Number.isNaN(ttlSec) || ttlSec <= 0) return opts.defaultTtlSec
  return Math.min(ttlSec, opts.maxTtlSec)
}

/**
 * Is an ask still open — answerable, and worth showing? Open from slightly
 * before its send time (skew) until `requestTtlSec` after it. There is
 * deliberately no "declined" state: the ONLY ways out are acceptance and this
 * window closing, so a "no" is indistinguishable from a phone in a pocket.
 */
export function requestOpen(
  req: SessionRequest,
  nowSec: number,
  opts: RadarSessionOptions = RADAR_SESSION,
): boolean {
  if (nowSec < req.sentAtSec - opts.clockSkewSec) return false
  return nowSec <= req.sentAtSec + opts.requestTtlSec + opts.clockSkewSec
}

/**
 * A newer ask REPLACES an older one for the same pair — asks never stack, so
 * repeated asking cannot become pressure by accumulation. The newest send
 * time wins; ties keep the incumbent.
 */
export function supersedes(prev: SessionRequest | null, next: SessionRequest): boolean {
  if (!prev) return true
  return next.sentAtSec > prev.sentAtSec
}

/**
 * Accept an open ask → a live session on the acceptor's clock. Returns null
 * when the ask is no longer open (the acceptor raced the window) — the caller
 * shows nothing; an accept of a dead ask must not resurrect it.
 */
export function acceptSession(
  req: SessionRequest,
  nowSec: number,
  opts: RadarSessionOptions = RADAR_SESSION,
): RadarSession | null {
  if (!requestOpen(req, nowSec, opts)) return null
  return { sessionId: req.requestId, ttlSec: clampTtlSec(req.ttlSec, opts), startAtSec: nowSec }
}

/** Is the session live at `nowSec`? Skew-tolerant on both edges. A session
 *  whose recorded TTL somehow exceeds the cap is still cut at the cap. */
export function sessionActive(
  s: RadarSession,
  nowSec: number,
  opts: RadarSessionOptions = RADAR_SESSION,
): boolean {
  if (nowSec < s.startAtSec - opts.clockSkewSec) return false
  return nowSec <= s.startAtSec + Math.min(s.ttlSec, opts.maxTtlSec) + opts.clockSkewSec
}

/** Whole seconds of session left (0 when over) — the pill's countdown. */
export function sessionRemainingSec(
  s: RadarSession,
  nowSec: number,
  opts: RadarSessionOptions = RADAR_SESSION,
): number {
  const end = s.startAtSec + Math.min(s.ttlSec, opts.maxTtlSec)
  return Math.max(0, Math.floor(end - nowSec))
}

/**
 * How often the publisher should beacon while THIS session is live: the moving
 * floor when moving, the stationary keepalive otherwise. This is the whole of
 * a session's power — cadence. Precision stays whatever the member's posture
 * allows; policy caps and no-report zones apply exactly as without a session.
 */
export function sessionCadenceSec(
  moving: boolean,
  opts: RadarSessionOptions = RADAR_SESSION,
): number {
  return moving ? opts.cadenceMovingSec : opts.cadenceStationarySec
}
