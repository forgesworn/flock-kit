/**
 * Radar navigation to a person — the pure math and cue state.
 *
 * Turns "my fix + their disclosed location + my device heading" into an honest
 * guidance state and a beep/haptic cadence, so the privacy and stale-data rules
 * live here (tested) rather than in DOM code. The UI layer renders the state
 * and plays the cue; this module never touches sensors, audio or transport.
 *
 * The honest model (see docs/plans/2026-07-09-radar-navigation-goal.md): radar
 * is a better way to CONSUME a permitted disclosure, not a new power to obtain
 * one. So a coarse share is never presented as a precise pointer, a stale
 * target degrades the cue instead of guiding confidently, and a withheld /
 * absent target reads as unavailable — never a fabricated position.
 *
 * Pure, synchronous, deterministic — no I/O, no Date.now(), no mutation.
 * Ages and positions are inputs; geohash decoding stays at the edge.
 */

import { haversineMetres, type LatLng } from './geofence.js'

/** Tuning constants — exported so the UI and tests share one vocabulary. */
export const RADAR = {
  /** A fix this young reads as "just now". */
  freshSeconds: 60,
  /** Beyond this the target is stale — matches the app's presence window. */
  staleSeconds: 600,
  /** Within this of a precise target you have arrived — the endgame runs to
   *  touching distance. The disclosed uncertainty still caps it (an exact
   *  share arrives at its ~2.4 m cell), so this never claims sub-cell
   *  precision; it only stops guidance going silent 15 m short. */
  arriveMetres: 2,
  /** Disclosed uncertainty above this is a coarse share — area guidance only. */
  coarseUncertaintyMetres: 50,
  /** |angular error| at or under this counts as aligned. */
  alignedDegrees: 20,
  /** …and at or under this as nearly aligned (correcting). */
  nearDegrees: 60,
  /** Distance tiers for the cue cadence. */
  closeMetres: 75,
  nearMetres: 300,
  /** A target shift under this floor is GPS jitter, not movement. */
  minMoveMetres: 25,
  /** Own-movement floor before a GPS course over ground is trusted. */
  minCourseMetres: 8,
  /** A bearing to a point you may already be inside is fiction — require the
   *  distance to clear the uncertainty by this factor before pointing. The v2
   *  honesty gate applies the SAME factor to MY OWN fix accuracy (radar-v2
   *  Fault 4): a bad fix degrades pointing exactly like a coarse share. */
  bearingSlackFactor: 1.25,

  // ── v2: heading engine (radar-v2 §"The heading engine") ────────────────────
  /** At/above this ground speed, GPS course wins and the compass is NEVER
   *  consulted — in a vehicle the magnetometer is confidently wrong. */
  headingCourseSpeedMps: 3,
  /** Below this ground speed, a platform-usable compass wins (you may be
   *  turning on the spot, where course over ground is meaningless). */
  headingCompassSpeedMps: 1,
  /** Between the two speeds, prefer the compass unless it disagrees with recent
   *  course by more than this — then course wins and "compass unreliable" shows. */
  headingDisagreeDegrees: 60,
  /** Dead band on the turn-direction SIGN so left/right never ping-pongs on the
   *  beam. Pan (a continuous channel) is unaffected. */
  signDeadbandDegrees: 8,

  // ── v2: mode machine (radar-v2 §"The three modes") ─────────────────────────
  /** VECTOR enter: sustained ground speed at/above this for `vectorEnterSustainSec`. */
  vectorEnterSpeedMps: 5,
  vectorEnterSustainSec: 5,
  /** …or unconditionally beyond this range (a far approach is a vehicle task). */
  vectorEnterDistanceMetres: 2000,
  /** VECTOR exit: sustained speed below this for `vectorExitSustainSec` AND
   *  back inside `vectorExitDistanceMetres` (hysteresis — never flaps). */
  vectorExitSpeedMps: 2,
  vectorExitSustainSec: 10,
  vectorExitDistanceMetres: 1500,
  /** HOMING enter/exit (the last ~30 m), with hysteresis. */
  homingEnterMetres: 25,
  homingExitMetres: 40,
  /** HOMING is only ever offered to a precise target — a coarse share never
   *  gets a homing endgame (the honesty rule, unchanged). */
  homingMaxUncertaintyMetres: 10,

  // ── v2: my-accuracy honesty gate + arrival rework (Fault 4) ────────────────
  /** Arrival grows with MY OWN fix accuracy: you have "arrived" once you are
   *  inside GPS reach, not when you orbit your own noise. */
  arriveAccuracyFactor: 0.8,
  /** Inside this multiple of my fix accuracy the me→target bearing is GPS
   *  fiction — HOMING DROPS the arrow and guides by warmer/colder + cadence. */
  homingBearingFactor: 3,

  // ── v2: HOMING continuous geiger cadence ───────────────────────────────────
  /** Cadence anchors: ~`homingPeriodFarMs` at `homingFarMetres`, interpolating
   *  down to ~`homingPeriodNearMs` at `homingNearMetres`. Pitch rises with it. */
  homingFarMetres: 30,
  homingNearMetres: 3,
  homingPeriodFarMs: 1200,
  homingPeriodNearMs: 250,
  homingToneFarHz: 700,
  homingToneNearHz: 1400,

  // ── v2: warmer/colder trend ────────────────────────────────────────────────
  /** Smoothed d(distance)/dt beyond ±this reads as closing / receding. */
  trendClosingMps: 0.4,

  // ── v2: voice milestones (VECTOR), metres, descending ──────────────────────
  voiceMilestonesMetres: [2000, 1000, 500, 250, 100],
  /** No two voice lines closer together than this (arrival excepted). */
  voiceMinIntervalSec: 10,

  // ── v2.1 (field test 2026-07-21): periodic voice + course trust floor ──────
  /** The minute-cadence status line: every this-many seconds the voice channel
   *  re-states range and clock-face direction, in every mode — the by-ear
   *  equivalent of glancing at the scope. */
  periodicVoiceSec: 60,
  /** A Doppler course over ground is only trusted at/above this ground speed —
   *  below it the chip is repeating a stationary artefact, which froze the
   *  pointer at the last walking direction when the phone was set down. */
  courseMinSpeedMps: 1,

  // ── Phase 3: BLE RSSI proximity assist (radar-v2 §"BLE RSSI assist") ───────
  // RSSI is pseudo-science as a ruler, honest as a band: the mesh's identified
  // GATT link to the target member yields signal-strength samples; a median
  // over a short window maps to bands ONLY — no metres are ever derived or
  // spoken from radio. Bands may floor the HOMING cadence, hold HOMING against
  // indoor GPS wobble, and speak "Very close — by Bluetooth". They never make
  // a bearing, and a coarse share never blends (the honesty rule, unchanged).
  /** Median RSSI (dBm) at/above this reads as immediate — same-room close. */
  bleImmediateRssi: -60,
  /** …at/above this as near; anything weaker is far (in radio range, no more). */
  bleNearRssi: -80,
  /** Fewer window samples than this claims no band at all (null). */
  bleMinSamples: 3,
  /** BLE may only blend while GPS itself already places the target within
   *  this — radio never contradicts an absent or distant GPS story. */
  bleAssistMaxMetres: 50,
  /** Cadence floors: an immediate band paces the geiger AS IF this close (and
   *  near likewise) — the cadence channel only, never the arrow or a number. */
  bleImmediateFloorMetres: 3,
  bleNearFloorMetres: 10,
  /** Band hysteresis (dBm): the incumbent band is sticky by this margin, so a
   *  fading link sitting on a boundary doesn't flap the cadence tick-to-tick.
   *  Promotion needs the median clearly ABOVE a threshold (+margin), demotion
   *  clearly BELOW (−margin) — like the clock-hour sticky band, for radio. */
  bleBandHysteresisDb: 4,

  // ── Direction callouts (field feedback 2026-07-21): a meaningful change of
  // clock hour — 3 o'clock becoming 2 o'clock — is ALWAYS spoken, in every
  // mode, while the bearing is honest. The compass must be followable by
  // sound alone from vehicle range down to the exact spot. ──────────────────
  /** A spoken/displayed clock hour only flips once the bearing is this far
   *  past its sector boundary — otherwise a target sat on the 15° line
   *  between two hours would chatter "2 o'clock… 3 o'clock…" forever. */
  clockHourHysteresisDeg: 6,
  /** Direction callouts get their own, faster floor than the general voice
   *  rate limit — a turned corner must not wait 10 s to be corrected. */
  voiceDirectionMinIntervalSec: 5,
} as const

export type RadarOptions = typeof RADAR

/** The selected person's disclosed location, as the radar consumes it: a
 *  position (the cell centre for a coarse share), the disclosed uncertainty
 *  radius, and how old the observation is. */
export interface TargetObservation {
  position: LatLng
  uncertaintyMetres: number
  ageSeconds: number
}

/** Everything the guidance decision needs, gathered by the caller. */
export interface RadarInput {
  /** My latest fix, or null when the phone has none yet. */
  me: LatLng | null
  /** Device heading in degrees clockwise from north, or null (no heading). This
   *  is the RESOLVED heading — the caller runs {@link resolveHeading} first, so
   *  the guidance and the cue never see a source the arbiter rejected. */
  headingDeg: number | null
  /** The selected target, or null (not sharing / withheld / no beacon). */
  target: TargetObservation | null
  /** My own fix accuracy radius in metres (coords.accuracy / getAccuracy), or
   *  null when unknown. Extends the honesty gate (Fault 4): a bad fix of MINE
   *  degrades pointing and grows arrival, exactly like a coarse share. When
   *  null the gate is unchanged from v1. */
  myAccuracyMetres?: number | null
}

export type Freshness = 'fresh' | 'aging' | 'stale'
export type Alignment = 'aligned' | 'near' | 'off'
/** Which way to turn, eyes/ears-free — or null on-beam / no honest bearing. */
export type TurnSign = 'left' | 'right' | null
/** Warmer/colder trend of the range (HOMING) — or null when unknown/flat. */
export type Trend = 'closing' | 'receding' | null
/** Radio proximity band to an IDENTIFIED mesh member (Phase 3) — or null when
 *  the mesh is off, the window is thin, or the target runs no radio (a pin). */
export type BleProximity = 'immediate' | 'near' | 'far' | null
/** The three guidance modes (radar-v2). One radar, three faces. */
export type RadarMode = 'vector' | 'seek' | 'homing'

/**
 * The guidance state, in strict honesty order:
 *  - `unavailable` — nothing to navigate to; say so, never point.
 *  - `no-fix`      — the target exists but I don't know where I am yet.
 *  - `stale`       — their last fix is too old to guide by.
 *  - `coarse`      — they share an area, not a spot: range guidance only.
 *  - `arrived`     — within arrival range of a live precise target.
 *  - `no-heading`  — live target but no compass: distance-paced fallback.
 *  - `point`       — full bearing guidance.
 */
export type RadarState = 'unavailable' | 'no-fix' | 'stale' | 'coarse' | 'arrived' | 'no-heading' | 'point'

export interface RadarGuidance {
  state: RadarState
  /** Metres to the disclosed position, or null when either side is unknown. */
  distanceMetres: number | null
  /** True bearing me → target (deg from north), or null when unknown. */
  bearingDeg: number | null
  /** Bearing relative to the device heading, -180..180 (null without both). */
  relativeBearingDeg: number | null
  freshness: Freshness | null
  /** Alignment tier — only ever set when the bearing is honestly usable. */
  alignment: Alignment | null
  /** May the UI/cue present the bearing as guidance? False for coarse, stale, a
   *  distance inside the target's uncertainty, OR — new in v2 — inside my own
   *  fix accuracy (pointing would overclaim either way). */
  bearingUsable: boolean
  /** The disclosed uncertainty radius, for the UI's honesty band. */
  uncertaintyMetres: number | null
  /** My own fix accuracy radius (echoed for the cue/view's HOMING arrow-drop
   *  decision), or null when unknown. */
  myAccuracyMetres: number | null
}

/** One beep/haptic cadence step, held until the guidance changes.
 *  Pattern vocabulary is the goal doc's grammar: "beep ... beep ...
 *  beep beep ... beep beep beep", plus sparse (degraded) and silent. */
export interface RadarCue {
  pattern: 'silent' | 'sparse' | 'single' | 'double' | 'triple'
  /** Time between bursts. Meaningless for `silent`. */
  periodMs: number
  /** Oscillator pitch; 0 for silent. */
  toneHz: number
  /** One burst's vibration pattern (navigator.vibrate shape). */
  vibrateMs: number[]
  /** Stereo pan for turn direction: −1 hard left … 0 centred … +1 hard right.
   *  0 whenever the bearing is not honestly usable (a coarse/stale target and
   *  the HOMING arrow-drop all read as centred — no directional claim). */
  pan: number
  /** Turn-direction haptic played BETWEEN cadence bursts when off-beam:
   *  right = two short taps, left = one long buzz (the controller owns the
   *  waveform). null on-beam or with no honest bearing. */
  sign: TurnSign
  /** Warmer/colder second note (HOMING only): rising when closing, falling when
   *  receding, null otherwise. Every audible trend keeps a haptic mirror. */
  trend: Trend
}

function validateLatLng(p: LatLng, label: string): void {
  if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number' ||
      Number.isNaN(p.lat) || Number.isNaN(p.lon)) {
    throw new Error(`Invalid ${label}: lat and lon must be numbers`)
  }
  if (p.lat < -90 || p.lat > 90) {
    throw new Error(`Invalid ${label}: lat must be between -90 and 90, got ${p.lat}`)
  }
  if (p.lon < -180 || p.lon > 180) {
    throw new Error(`Invalid ${label}: lon must be between -180 and 180, got ${p.lon}`)
  }
}

const toRad = (deg: number): number => (deg * Math.PI) / 180
const toDeg = (rad: number): number => (rad * 180) / Math.PI

/** Normalise an angle to [0, 360). */
function norm360(deg: number): number {
  const d = deg % 360
  return d < 0 ? d + 360 : d
}

/**
 * Initial great-circle bearing from `a` towards `b`, degrees clockwise from
 * north, in [0, 360).
 *
 * @throws {Error} If either coordinate is out of range.
 */
export function initialBearingDeg(a: LatLng, b: LatLng): number {
  validateLatLng(a, 'point a')
  validateLatLng(b, 'point b')
  const phi1 = toRad(a.lat)
  const phi2 = toRad(b.lat)
  const dLambda = toRad(b.lon - a.lon)
  const y = Math.sin(dLambda) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda)
  return norm360(toDeg(Math.atan2(y, x)))
}

/**
 * Signed angular error between the target bearing and the device heading, in
 * (-180, 180]: positive = the target is to the right (turn clockwise).
 */
export function angularErrorDeg(bearingDeg: number, headingDeg: number): number {
  const d = norm360(bearingDeg - headingDeg)
  return d > 180 ? d - 360 : d
}

/** Age → freshness tier. The stale window matches the app's presence view, so
 *  the tracker and the map never tell two different stories. */
export function classifyFreshness(ageSeconds: number, opts: RadarOptions = RADAR): Freshness {
  if (ageSeconds <= opts.freshSeconds) return 'fresh'
  if (ageSeconds <= opts.staleSeconds) return 'aging'
  return 'stale'
}

/** The guidance decision — see {@link RadarState} for the honesty order. */
export function radarGuidance(input: RadarInput, opts: RadarOptions = RADAR): RadarGuidance {
  const myAccuracyMetres = input.myAccuracyMetres ?? null
  const none: RadarGuidance = {
    state: 'unavailable',
    distanceMetres: null,
    bearingDeg: null,
    relativeBearingDeg: null,
    freshness: null,
    alignment: null,
    bearingUsable: false,
    uncertaintyMetres: null,
    myAccuracyMetres,
  }
  if (!input.target) return none

  const t = input.target
  const freshness = classifyFreshness(t.ageSeconds, opts)
  if (!input.me) {
    return { ...none, state: 'no-fix', freshness, uncertaintyMetres: t.uncertaintyMetres }
  }

  const distanceMetres = haversineMetres(input.me, t.position)
  const bearingDeg = initialBearingDeg(input.me, t.position)
  const relativeBearingDeg = input.headingDeg === null ? null : angularErrorDeg(bearingDeg, input.headingDeg)
  const coarse = t.uncertaintyMetres > opts.coarseUncertaintyMetres

  // My own fix accuracy is the second honesty limit (Fault 4): a 12 m fix can
  // not honestly point at a spot 10 m away. A null accuracy leaves v1 behaviour.
  const myAccSlack = myAccuracyMetres === null ? 0 : myAccuracyMetres * opts.bearingSlackFactor
  const bearingUsable =
    !coarse &&
    freshness !== 'stale' &&
    distanceMetres > t.uncertaintyMetres * opts.bearingSlackFactor &&
    distanceMetres > myAccSlack

  const alignment: Alignment | null =
    bearingUsable && relativeBearingDeg !== null
      ? Math.abs(relativeBearingDeg) <= opts.alignedDegrees
        ? 'aligned'
        : Math.abs(relativeBearingDeg) <= opts.nearDegrees
          ? 'near'
          : 'off'
      : null

  // Arrival now also clears MY fix accuracy: "within GPS reach" beats orbiting
  // my own noise. Null accuracy contributes nothing, so v1 arrival is unchanged.
  const arriveRadius = Math.max(
    opts.arriveMetres,
    t.uncertaintyMetres,
    myAccuracyMetres === null ? 0 : myAccuracyMetres * opts.arriveAccuracyFactor,
  )

  const state: RadarState =
    freshness === 'stale'
      ? 'stale'
      : !coarse && distanceMetres <= arriveRadius
        ? 'arrived'
        : coarse
          ? 'coarse'
          : input.headingDeg === null
            ? 'no-heading'
            : 'point'

  return {
    state,
    distanceMetres,
    bearingDeg,
    relativeBearingDeg,
    freshness,
    alignment,
    bearingUsable,
    uncertaintyMetres: t.uncertaintyMetres,
    myAccuracyMetres,
  }
}

/** The degraded low pulse — deliberately duller and slower than any live cue,
 *  so stale/coarse/unavailable can never be mistaken for confident guidance. */
const SPARSE_TONE_HZ = 330

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

/**
 * Stereo pan for a relative bearing: `clamp(relativeBearing / 90, −1, 1)` — a
 * target 90°+ to the side pans hard, on-beam sits centred. Null relative
 * bearing (or a bearing that is not honestly usable) is the caller's job to
 * gate; this is the raw geometry.
 */
export function panFor(relativeBearingDeg: number | null): number {
  if (relativeBearingDeg === null) return 0
  return clamp(relativeBearingDeg / 90, -1, 1)
}

/**
 * Turn-direction sign with a dead band so left/right never ping-pongs on the
 * beam: within ±`deadbandDeg` the sign is null (on-beam, cadence only), outside
 * it the side the target lies on (positive relative bearing = right).
 */
export function turnSign(
  relativeBearingDeg: number | null,
  deadbandDeg: number = RADAR.signDeadbandDegrees,
): TurnSign {
  if (relativeBearingDeg === null || Math.abs(relativeBearingDeg) <= deadbandDeg) return null
  return relativeBearingDeg > 0 ? 'right' : 'left'
}

/**
 * Smoothed range rate → warmer/colder trend. `closingRateMps` is d(distance)/dt
 * (negative = closing); beyond ±`trendClosingMps` it reads as closing /
 * receding, inside the band as flat (null). Null rate (unknown) → null.
 */
export function classifyTrend(closingRateMps: number | null, opts: RadarOptions = RADAR): Trend {
  if (closingRateMps === null || Number.isNaN(closingRateMps)) return null
  if (closingRateMps < -opts.trendClosingMps) return 'closing'
  if (closingRateMps > opts.trendClosingMps) return 'receding'
  return null
}

/** Whether the me→target bearing is honest to POINT at from close range: the
 *  arrow becomes GPS fiction inside `homingBearingFactor × my fix accuracy`
 *  (Fault 4). With no known accuracy, defer to the plain bearingUsable gate. */
function bearingHonestForHoming(g: RadarGuidance, opts: RadarOptions): boolean {
  if (!g.bearingUsable) return false
  if (g.myAccuracyMetres === null) return true
  return (g.distanceMetres ?? 0) > g.myAccuracyMetres * opts.homingBearingFactor
}

/** Extra context the cue needs beyond the pure guidance: which mode is active
 *  and the smoothed closing rate (for the HOMING warmer/colder note). */
export interface CueContext {
  /** Active guidance mode; defaults to SEEK (v1 behaviour) when omitted. */
  mode?: RadarMode
  /** Smoothed d(distance)/dt in m/s (negative = closing), or null if unknown. */
  closingRateMps?: number | null
  /** Radio proximity to the target member (Phase 3), or null/omitted — a pin,
   *  a mesh-less target and v2.1 callers all read as null (no blend). */
  bleProximity?: BleProximity
}

// ── Phase 3: BLE RSSI proximity assist ───────────────────────────────────────

/** Median of an RSSI sample window (dBm), or null on an empty window. The
 *  median — not the mean — because BLE fading throws wild outliers. */
export function medianRssi(samples: readonly number[]): number | null {
  const clean = samples.filter((s) => typeof s === 'number' && !Number.isNaN(s))
  if (clean.length === 0) return null
  const sorted = [...clean].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * RSSI sample window → proximity band. Bands only — RSSI-to-metres is
 * pseudo-science and no number is ever derived from radio. A window thinner
 * than `bleMinSamples` claims nothing (null): one lucky packet is not
 * proximity.
 *
 * `prevBand` (the last band this link reported) makes the boundaries STICKY:
 * BLE fading can swing a stationary link's median a few dB across a threshold
 * every window, and without hysteresis the cadence floor would flap. Promotion
 * to a stronger band needs the median clearly above its threshold (+margin);
 * demotion needs it clearly below (−margin); the incumbent holds through the
 * band in between. A fresh window (`prevBand` null — first read, or after a
 * dropout thinned the window) re-acquires at the raw thresholds.
 */
export function bleProximityFromRssi(
  samples: readonly number[],
  opts: RadarOptions = RADAR,
  prevBand: BleProximity = null,
): BleProximity {
  const clean = samples.filter((s) => typeof s === 'number' && !Number.isNaN(s))
  if (clean.length < opts.bleMinSamples) return null
  const median = medianRssi(clean) as number
  if (prevBand === null) {
    if (median >= opts.bleImmediateRssi) return 'immediate'
    if (median >= opts.bleNearRssi) return 'near'
    return 'far'
  }
  // Sticky boundaries: raise the bar to climb a band, lower it to fall — the
  // incumbent band holds through the ±margin around each threshold.
  const h = opts.bleBandHysteresisDb
  const immediateThreshold = prevBand === 'immediate' ? opts.bleImmediateRssi - h : opts.bleImmediateRssi + h
  const nearThreshold = prevBand === 'far' ? opts.bleNearRssi + h : opts.bleNearRssi - h
  if (median >= immediateThreshold) return 'immediate'
  if (median >= nearThreshold) return 'near'
  return 'far'
}

/**
 * May BLE proximity blend into guidance AT ALL? The honesty gates from the
 * design doc, in one place:
 *  - a band must exist (mesh on, window thick enough);
 *  - the target must not be a deliberately coarse share (radio must never
 *    sharpen a disclosure below its chosen precision);
 *  - GPS itself must already place the target within `bleAssistMaxMetres` —
 *    radio corroborates a near story, it never replaces an absent one.
 */
export function bleAssistUsable(
  g: RadarGuidance,
  bleProximity: BleProximity,
  opts: RadarOptions = RADAR,
): boolean {
  if (bleProximity === null) return false
  if (g.uncertaintyMetres === null || g.uncertaintyMetres > opts.coarseUncertaintyMetres) return false
  if (g.distanceMetres === null || g.distanceMetres > opts.bleAssistMaxMetres) return false
  return true
}

/** The cadence floor a band buys (metres the geiger paces AS IF), or null for
 *  far/none — a far band proves radio range, not closeness, and paces nothing. */
export function bleCadenceFloorMetres(
  bleProximity: BleProximity,
  opts: RadarOptions = RADAR,
): number | null {
  if (bleProximity === 'immediate') return opts.bleImmediateFloorMetres
  if (bleProximity === 'near') return opts.bleNearFloorMetres
  return null
}

/** HOMING geiger cadence: burst period and pitch interpolate continuously with
 *  range (fast + high when near, slow + low when far). Direction cues survive
 *  only while the arrow is honest; otherwise warmer/colder + cadence carry it.
 *  A usable BLE band FLOORS the pacing distance (immediate ⇒ paced as ≤3 m)
 *  so the endgame quickens indoors where the GPS range is fiction — the
 *  cadence channel only; arrow, pan and sign never come from radio. */
function homingCue(g: RadarGuidance, ctx: CueContext, opts: RadarOptions): RadarCue {
  const bleFloor = bleAssistUsable(g, ctx.bleProximity ?? null, opts)
    ? bleCadenceFloorMetres(ctx.bleProximity ?? null, opts)
    : null
  const dRaw = g.distanceMetres ?? opts.homingFarMetres
  const d = clamp(bleFloor === null ? dRaw : Math.min(dRaw, bleFloor), opts.homingNearMetres, opts.homingFarMetres)
  const span = opts.homingFarMetres - opts.homingNearMetres
  const f = span > 0 ? (d - opts.homingNearMetres) / span : 0 // 0 at the near anchor … 1 at the far anchor
  const periodMs = Math.round(opts.homingPeriodNearMs + f * (opts.homingPeriodFarMs - opts.homingPeriodNearMs))
  const toneHz = Math.round(opts.homingToneNearHz + f * (opts.homingToneFarHz - opts.homingToneNearHz))
  const honest = bearingHonestForHoming(g, opts)
  const rel = g.relativeBearingDeg
  return {
    pattern: 'single',
    periodMs,
    toneHz,
    vibrateMs: [40],
    pan: honest ? panFor(rel) : 0,
    sign: honest ? turnSign(rel, opts.signDeadbandDegrees) : null,
    trend: classifyTrend(ctx.closingRateMps ?? null, opts),
  }
}

/** VECTOR cue: voice is the primary channel, so the earcon stays a sparse slow
 *  prompt — a driver needs the odd ping, not a metronome. Pan/sign still ride
 *  along (course-relative) for the stereo/haptic mirror. */
function vectorCue(g: RadarGuidance, opts: RadarOptions): RadarCue {
  const honest = g.bearingUsable
  const rel = g.relativeBearingDeg
  return {
    pattern: 'single',
    periodMs: 3000,
    toneHz: 660,
    vibrateMs: [40],
    pan: honest ? panFor(rel) : 0,
    sign: honest ? turnSign(rel, opts.signDeadbandDegrees) : null,
    trend: null,
  }
}

/**
 * Guidance → one cadence step of the beep grammar.
 *
 * The invariants the tests hold: cadence accelerates and brightens only as the
 * user aligns and closes on a LIVE precise target; every degraded state is a
 * sparse dull pulse; arrival is immediate silence plus one confirming haptic;
 * every audible cue has a haptic mirror. v2 adds three honesty-gated channels —
 * stereo pan, a turn-direction sign, and a warmer/colder trend — that exist
 * ONLY when the bearing is usable; a coarse or stale target still gets the bare
 * sparse pulse with no directional content.
 */
export function cueFor(g: RadarGuidance, ctx: CueContext = {}, opts: RadarOptions = RADAR): RadarCue {
  const mode = ctx.mode ?? 'seek'
  const centred = { pan: 0, sign: null as TurnSign, trend: null as Trend }
  switch (g.state) {
    case 'unavailable':
    case 'no-fix':
      return { pattern: 'sparse', periodMs: 4000, toneHz: SPARSE_TONE_HZ, vibrateMs: [30], ...centred }
    case 'stale':
      return { pattern: 'sparse', periodMs: 3500, toneHz: SPARSE_TONE_HZ, vibrateMs: [30], ...centred }
    case 'coarse': {
      // Range-only guidance: quicken slightly as the disclosed area nears, but
      // stay sparse — a coarse share must never sound like a precise pointer.
      const d = g.distanceMetres ?? Infinity
      const u = g.uncertaintyMetres ?? opts.coarseUncertaintyMetres
      const periodMs = d <= u ? 2000 : d <= u * 3 ? 2400 : 3000
      return { pattern: 'sparse', periodMs, toneHz: 440, vibrateMs: [40], ...centred }
    }
    case 'arrived':
      // Arrival wins over any mode: immediate silence, one confirming haptic.
      return { pattern: 'silent', periodMs: 0, toneHz: 0, vibrateMs: [80, 60, 80], ...centred }
    case 'no-heading': {
      // No honest bearing at all. In HOMING the geiger cadence + warmer/colder
      // still carry the endgame; elsewhere it's the distance-paced pulse.
      if (mode === 'homing') return homingCue(g, ctx, opts)
      const d = g.distanceMetres ?? Infinity
      const periodMs = d < opts.closeMetres ? 1000 : d < opts.nearMetres ? 1600 : 2400
      return { pattern: 'single', periodMs, toneHz: 660, vibrateMs: [40], ...centred }
    }
    case 'point': {
      if (mode === 'homing') return homingCue(g, ctx, opts)
      if (mode === 'vector') return vectorCue(g, opts)
      const d = g.distanceMetres ?? Infinity
      const pan = g.bearingUsable ? panFor(g.relativeBearingDeg) : 0
      const sign = g.bearingUsable ? turnSign(g.relativeBearingDeg, opts.signDeadbandDegrees) : null
      const dir = { pan, sign, trend: null as Trend }
      switch (g.alignment) {
        case 'aligned':
          return d < opts.closeMetres
            ? { pattern: 'triple', periodMs: 700, toneHz: 1175, vibrateMs: [40, 60, 40, 60, 40], ...dir }
            : { pattern: 'double', periodMs: 1100, toneHz: 990, vibrateMs: [40, 60, 40], ...dir }
        case 'near':
          return { pattern: 'single', periodMs: 1600, toneHz: 740, vibrateMs: [40], ...dir }
        case 'off':
          return { pattern: 'single', periodMs: 2400, toneHz: 494, vibrateMs: [30], ...dir }
        default:
          // Bearing not honestly usable (e.g. just outside arrival range of an
          // uncertain-but-precise target) — distance pulse, no bearing claim.
          return { pattern: 'single', periodMs: 1600, toneHz: 660, vibrateMs: [40], ...centred }
      }
    }
  }
}

/** A position with its disclosed uncertainty — the movement comparison unit. */
export interface PositionObservation {
  position: LatLng
  uncertaintyMetres: number
}

/**
 * Did the target genuinely move between two observations? True only when the
 * shift exceeds both the jitter floor and each observation's own uncertainty —
 * a coarse share "moves" only on a cell-sized change, and a precise one never
 * "moves" on GPS noise. The UI uses this for the distinct "target moved" pulse.
 */
export function targetMoved(
  prev: PositionObservation | null,
  next: PositionObservation,
  opts: RadarOptions = RADAR,
): boolean {
  if (!prev) return false
  const d = haversineMetres(prev.position, next.position)
  return d > Math.max(opts.minMoveMetres, prev.uncertaintyMetres, next.uncertaintyMetres)
}

/** A fix of my own, timestamped, for the course-over-ground fallback. */
export interface TimedPosition {
  position: LatLng
  atSec: number
}

/**
 * Course over ground from two of my own fixes — the heading fallback when the
 * compass is missing or unreliable ("walk a few steps"). Null when the fixes
 * are too close to trust (jitter) or out of order.
 */
export function courseFromFixes(
  prev: TimedPosition,
  next: TimedPosition,
  minMetres: number = RADAR.minCourseMetres,
): number | null {
  if (next.atSec <= prev.atSec) return null
  if (haversineMetres(prev.position, next.position) < minMetres) return null
  return initialBearingDeg(prev.position, next.position)
}

// ── The heading engine (radar-v2 Fault 1) ────────────────────────────────────

/** Everything the arbiter needs to decide which way I'm facing. The caller
 *  surfaces all of it (compass + its platform accuracy grade, GPS course +
 *  speed) so the compass no longer wins unconditionally. */
export interface HeadingInput {
  /** Magnetometer heading (deg clockwise from north), or null (no compass). */
  compassDeg: number | null
  /** Is the compass platform-usable? The OS's own accuracy grade —
   *  `onAccuracyChanged` UNRELIABLE/LOW makes this false. A false grade removes
   *  the compass from the arbitration entirely. */
  compassUsable: boolean
  /** GPS course over ground (deg clockwise from north), or null. */
  courseDeg: number | null
  /** My ground speed in m/s (Doppler `coords.speed`/`getSpeed`), or null. */
  speedMps: number | null
}

export type HeadingSource = 'compass' | 'course' | null
/** Heading-source health for the status line — the UI never claims a source
 *  the cue isn't actually using. */
export type HeadingStatus = 'ok' | 'compass-unreliable' | 'none'

export interface HeadingSolution {
  headingDeg: number | null
  source: HeadingSource
  status: HeadingStatus
}

const NO_HEADING: HeadingSolution = { headingDeg: null, source: null, status: 'none' }

/**
 * Arbitrate compass vs GPS course by speed (radar-v2 §"The heading engine"):
 *
 *  1. speed ≥ `headingCourseSpeedMps` → **course only**. The compass is NEVER
 *     consulted in the vehicle band; with no course (stopped at lights) we
 *     honestly report no heading rather than substitute the magnetometer.
 *  2. speed < `headingCompassSpeedMps` → **compass** if platform-usable, else
 *     course (walk-a-few-steps), else none.
 *  3. in between → prefer compass, UNLESS it disagrees with course by more than
 *     `headingDisagreeDegrees` — then course wins and the status is
 *     `compass-unreliable`.
 *
 * Pure and stateless; smoothing/dead-band are separate helpers the controller
 * drives with its own memory.
 */
export function resolveHeading(h: HeadingInput, opts: RadarOptions = RADAR): HeadingSolution {
  const speed = h.speedMps ?? 0
  const haveCourse = h.courseDeg !== null
  const haveCompass = h.compassDeg !== null && h.compassUsable
  const course = (): HeadingSolution => ({ headingDeg: norm360(h.courseDeg as number), source: 'course', status: 'ok' })
  const compass = (): HeadingSolution => ({ headingDeg: norm360(h.compassDeg as number), source: 'compass', status: 'ok' })

  // 1. Vehicle band — course only, compass never consulted.
  if (speed >= opts.headingCourseSpeedMps) return haveCourse ? course() : NO_HEADING

  // 2. Near-stationary — trust a usable compass (course over ground is noise).
  if (speed < opts.headingCompassSpeedMps) {
    if (haveCompass) return compass()
    if (haveCourse) return course()
    return NO_HEADING
  }

  // 3. In between — prefer compass, but course overrides a disagreeing compass.
  if (haveCompass) {
    if (haveCourse && Math.abs(angularErrorDeg(h.compassDeg as number, h.courseDeg as number)) > opts.headingDisagreeDegrees) {
      return { headingDeg: norm360(h.courseDeg as number), source: 'course', status: 'compass-unreliable' }
    }
    return compass()
  }
  if (haveCourse) return course()
  return NO_HEADING
}

/**
 * Circular exponential moving average: blend `prevDeg` a fraction `alpha`
 * (0..1) toward `nextDeg` along the SHORTEST arc, so it never smears the long
 * way round north. Null previous (first sample) adopts `nextDeg` outright.
 * `alpha = 1` is no smoothing; the controller uses a fast alpha in VECTOR and a
 * damped one in HOMING.
 */
export function smoothHeadingDeg(prevDeg: number | null, nextDeg: number, alpha: number): number {
  if (prevDeg === null) return norm360(nextDeg)
  const delta = angularErrorDeg(nextDeg, prevDeg) // shortest signed path prev→next
  return norm360(prevDeg + alpha * delta)
}

/**
 * Smoothed range rate for the warmer/colder trend: an EMA of instantaneous
 * d(distance)/dt (metres per second, negative = closing). Null previous adopts
 * the first instantaneous rate; a non-positive `dtSec` holds the previous rate.
 * The controller keeps the running value and feeds it back each tick.
 */
export function smoothClosingRate(
  prevRateMps: number | null,
  prevDistanceMetres: number,
  nextDistanceMetres: number,
  dtSec: number,
  alpha: number,
): number {
  if (dtSec <= 0) return prevRateMps ?? 0
  const inst = (nextDistanceMetres - prevDistanceMetres) / dtSec
  if (prevRateMps === null) return inst
  return prevRateMps + alpha * (inst - prevRateMps)
}

// ── The mode machine (radar-v2 §"The three modes") ───────────────────────────

/** Everything the mode selection needs. Durations are measured by the caller
 *  (how long speed has held above/below the VECTOR thresholds) so the decision
 *  stays a pure, deterministic, portable function with explicit hysteresis. */
export interface ModeInput {
  /** The mode currently shown — the hysteresis anchor. */
  prevMode: RadarMode
  distanceMetres: number | null
  speedMps: number | null
  /** Seconds speed has continuously held ≥ `vectorEnterSpeedMps`. */
  fastForSec: number
  /** Seconds speed has continuously held < `vectorExitSpeedMps`. */
  slowForSec: number
  /** The target's disclosed uncertainty — HOMING is offered to precise targets only. */
  uncertaintyMetres: number | null
  /** Radio proximity to the target member (Phase 3), or null/omitted. May HOLD
   *  an active HOMING against indoor GPS wobble; never enters one. */
  bleProximity?: BleProximity
}

/**
 * Choose VECTOR / SEEK / HOMING as a pure function of range, speed and signal
 * quality, with hysteresis so boundaries never flap. Manual override is the
 * controller's job (it pins a mode and skips this); "Auto" resumes calling here.
 *
 * Precedence: the precise endgame (HOMING) wins once inside its band, then the
 * vehicle band (VECTOR), else SEEK.
 */
export function selectMode(m: ModeInput, opts: RadarOptions = RADAR): RadarMode {
  const dist = m.distanceMetres ?? Infinity
  const coarseForHoming = (m.uncertaintyMetres ?? 0) > opts.homingMaxUncertaintyMetres

  // HOMING — the precise endgame, with enter/exit hysteresis. A near/immediate
  // BLE band HOLDS an active HOMING against indoor GPS wobble (accuracy
  // collapse walks the GPS range past the exit line while the member's radio
  // is demonstrably in the room) — hold only, within the blend ceiling, never
  // for a deliberately coarse share, and never a way IN.
  const ble = m.bleProximity ?? null
  const bleHold =
    (ble === 'immediate' || ble === 'near') &&
    dist <= opts.bleAssistMaxMetres &&
    (m.uncertaintyMetres ?? 0) <= opts.coarseUncertaintyMetres
  if (m.prevMode === 'homing') {
    if ((dist <= opts.homingExitMetres && !coarseForHoming) || bleHold) return 'homing'
  } else if (dist < opts.homingEnterMetres && !coarseForHoming) {
    return 'homing'
  }

  // VECTOR — the vehicle / far band, with sustained-speed hysteresis.
  if (m.prevMode === 'vector') {
    const exit = m.slowForSec >= opts.vectorExitSustainSec && dist <= opts.vectorExitDistanceMetres
    if (!exit) return 'vector'
  } else {
    const enter = m.fastForSec >= opts.vectorEnterSustainSec || dist > opts.vectorEnterDistanceMetres
    if (enter) return 'vector'
  }

  return 'seek'
}

// ── Voice-line copy (radar-v2 cue grammar v2 — the TTS channel) ───────────────

/**
 * Which milestone (metres) was just crossed on the way IN, or null. Returns the
 * DEEPEST milestone now reached (the smallest `voiceMilestonesMetres` entry with
 * `prev > m` and `next ≤ m`), so a big jump announces the band you have entered,
 * never one you sailed past. A first sample (null prev) never announces.
 */
export function crossedMilestone(
  prevMetres: number | null,
  nextMetres: number,
  opts: RadarOptions = RADAR,
): number | null {
  if (prevMetres === null) return null
  let crossed: number | null = null
  for (const m of opts.voiceMilestonesMetres) {
    if (prevMetres > m && nextMetres <= m) crossed = m // descending list → last hit is the deepest
  }
  return crossed
}

/**
 * A relative bearing → a spoken clock-free direction phrase. Positive = the
 * target is to the right. Superseded for the voice channel by
 * {@link clockFacePhrase} (open-question #1 was resolved by the 2026-07-21
 * field test: clock-face reads faster than left/right prose); kept for any
 * caller that wants prose.
 */
export function vectorDirectionPhrase(relativeBearingDeg: number | null): string {
  if (relativeBearingDeg === null) return 'ahead'
  const a = relativeBearingDeg
  const mag = Math.abs(a)
  if (mag <= 15) return 'straight ahead'
  if (mag >= 165) return 'behind you'
  const side = a > 0 ? 'right' : 'left'
  if (mag <= 75) return `ahead on your ${side}`
  if (mag <= 105) return `to your ${side}`
  return `behind you on your ${side}`
}

/**
 * The clock hour a relative bearing falls on: 30° sectors centred on each hour,
 * dead ahead = 12, right = 3, behind = 6, left = 9. Null bearing → null.
 */
export function clockHour(relativeBearingDeg: number | null): number | null {
  if (relativeBearingDeg === null || Number.isNaN(relativeBearingDeg)) return null
  const sector = Math.round(norm360(relativeBearingDeg) / 30) % 12
  return sector === 0 ? 12 : sector
}

/** A relative bearing → the spoken clock-face phrase ("at your 3 o'clock"),
 *  or '' with no bearing (the caller drops to a range-only line). */
export function clockFacePhrase(relativeBearingDeg: number | null): string {
  const h = clockHour(relativeBearingDeg)
  return h === null ? '' : `at your ${h} o'clock`
}

/**
 * The clock hour with sector-boundary hysteresis — the one the UI displays and
 * the voice speaks. The raw {@link clockHour} flips exactly on the 15° line
 * between sectors, so a target sat on a boundary (or GPS jitter around it)
 * would chatter between neighbouring hours. This keeps the PREVIOUS hour until
 * the bearing is `clockHourHysteresisDeg` past its sector edge; a genuinely
 * big swing (more than one sector) still flips immediately.
 *
 * The controller feeds the result back as `prevHour` each tick, and raises a
 * `bearing-change` voice event whenever it changes — in EVERY mode, while the
 * bearing is honest (field feedback 2026-07-21: a 3 o'clock that has become a
 * 2 o'clock is always called out).
 */
export function stableClockHour(
  prevHour: number | null,
  relativeBearingDeg: number | null,
  opts: RadarOptions = RADAR,
): number | null {
  const raw = clockHour(relativeBearingDeg)
  if (raw === null) return null
  if (prevHour === null) return raw
  if (raw === prevHour) return prevHour
  // Sticky band: hold the previous hour while the bearing is still within its
  // sector grown by the hysteresis margin (sector half-width 15°).
  const prevCentreDeg = (prevHour % 12) * 30
  const offCentre = Math.abs(angularErrorDeg(norm360(relativeBearingDeg as number), prevCentreDeg))
  if (offCentre <= 15 + opts.clockHourHysteresisDeg) return prevHour
  return raw
}

/**
 * The enumerable spoken-range ladder, metres, ascending. The periodic voice
 * line rounds to the NEAREST step so every line it can speak is pre-bakeable
 * as an offline clip (GrapheneOS may have no TTS engine at all) — precision
 * honesty is untouched because the scope still shows the exact range.
 */
export const SPEAKABLE_DISTANCES_METRES = [
  10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750,
  1000, 1500, 2000, 3000, 4000, 5000, 10_000,
] as const

/** Round a range to the nearest {@link SPEAKABLE_DISTANCES_METRES} step
 *  (beyond the ladder: the top step). */
export function speakableDistanceMetres(metres: number): number {
  let best: number = SPEAKABLE_DISTANCES_METRES[0]
  for (const step of SPEAKABLE_DISTANCES_METRES) {
    if (Math.abs(step - metres) < Math.abs(best - metres)) best = step
  }
  return best
}

/** The events a voice line announces. Distances are pre-resolved by the caller
 *  so `voiceLine` stays formatter-agnostic (units follow the app's fmtDistance). */
export type VoiceEvent =
  | { kind: 'milestone'; distanceMetres: number }
  | { kind: 'mode'; mode: RadarMode }
  | { kind: 'degraded'; state: RadarState }
  | { kind: 'compass-unreliable' }
  | { kind: 'bearing-change' }
  | { kind: 'arrived' }
  /** The minute-cadence status line (v2.1): rounded range + clock-face
   *  direction, every mode. `distanceMetres` is pre-rounded by the caller
   *  (speakableDistanceMetres) so the line is always clip-composable. */
  | { kind: 'periodic'; distanceMetres: number }
  /** A genuine target move just landed (v2.1) — the spoken twin of the moved
   *  pulse, so a sparse-cadence target never reads as a frozen screen.
   *  `distanceMetres` pre-rounded like `periodic`. */
  | { kind: 'moved'; distanceMetres: number }
  /** The BLE band just became immediate during HOMING (Phase 3). The line
   *  claims radio proximity in radio words — never a distance number. */
  | { kind: 'ble-close' }

/**
 * Assemble one spoken line. `fmtDistance` renders metres in the user's units
 * (the same helper the visuals use), so a milestone reads "500 metres, at your
 * 2 o'clock". A voice line NEVER speaks a bearing the cue wouldn't beep — the
 * caller only raises direction-bearing events while the bearing is usable; the
 * periodic line degrades itself to range-only when the bearing isn't honest.
 */
export function voiceLine(ev: VoiceEvent, g: RadarGuidance, fmtDistance: (metres: number) => string): string {
  const clock = (): string => (g.bearingUsable ? clockFacePhrase(g.relativeBearingDeg) : '')
  const withClock = (dist: string): string => {
    const c = clock()
    return c ? `${dist}, ${c}` : dist
  }
  switch (ev.kind) {
    case 'milestone':
      return withClock(fmtDistance(ev.distanceMetres).replace('~', ''))
    case 'periodic':
      return withClock(fmtDistance(ev.distanceMetres).replace('~', ''))
    case 'moved':
      return `They've moved — ${withClock(fmtDistance(ev.distanceMetres).replace('~', ''))}`
    case 'bearing-change': {
      const c = clockFacePhrase(g.relativeBearingDeg)
      return c ? `Now ${c}` : ''
    }
    case 'mode':
      return ev.mode === 'vector' ? 'Vehicle mode' : ev.mode === 'homing' ? 'Closing in' : 'On-foot tracking'
    case 'compass-unreliable':
      return 'Compass unreliable — using your direction of travel'
    case 'ble-close':
      return 'Very close — by Bluetooth'
    case 'arrived':
      return 'Within GPS reach — look around'
    case 'degraded':
      switch (ev.state) {
        case 'stale':
          return 'Their location is stale — follow with care'
        case 'coarse':
          return 'Rough area only'
        case 'no-fix':
          return 'Waiting for your own position'
        case 'unavailable':
          return 'No location to navigate to'
        default:
          return ''
      }
  }
}
