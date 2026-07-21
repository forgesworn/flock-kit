// Public compatibility vectors for the native (Kotlin) radar guidance core. The radar rules
// are pure and deterministic, so every case is directly comparable: the same
// inputs must produce the same guidance state, cue and numbers on both sides —
// the locked-phone beeper must never be more confident than the tested JS
// tracker. Regenerate with `npm run gen:vectors` on a deliberate rule change.
// Cases sit AWAY from tier boundaries so float rounding can't flip a state.
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initialBearingDeg,
  angularErrorDeg,
  classifyFreshness,
  radarGuidance,
  cueFor,
  targetMoved,
  courseFromFixes,
  resolveHeading,
  selectMode,
  panFor,
  turnSign,
  classifyTrend,
  vectorDirectionPhrase,
  crossedMilestone,
  medianRssi,
  bleProximityFromRssi,
  bleAssistUsable,
  bleCadenceFloorMetres,
  stableClockHour,
  type RadarInput,
  type HeadingInput,
  type ModeInput,
  type CueContext,
  type BleProximity,
} from '../../src/radar'
import {
  clampTtlSec,
  requestOpen,
  supersedes,
  acceptSession,
  sessionActive,
  sessionRemainingSec,
  sessionCadenceSec,
  type SessionRequest,
  type RadarSession,
} from '../../src/radarSession'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'radar-vectors.json')

const BEARING_CASES = [
  { a: { lat: 0, lon: 0 }, b: { lat: 1, lon: 0 } },
  { a: { lat: 0, lon: 0 }, b: { lat: 0, lon: 1 } },
  { a: { lat: 0, lon: 0 }, b: { lat: -1, lon: 0 } },
  { a: { lat: 0, lon: 0 }, b: { lat: 0, lon: -1 } },
  { a: { lat: 0, lon: 0 }, b: { lat: 1, lon: 1 } },
  { a: { lat: 51.5, lon: -0.12 }, b: { lat: 51.51, lon: -0.13 } },
  { a: { lat: 51.5, lon: -0.12 }, b: { lat: 48.8566, lon: 2.3522 } },
]

const ANGULAR_CASES = [
  { bearing: 30, heading: 0 }, { bearing: 330, heading: 0 },
  { bearing: 10, heading: 350 }, { bearing: 350, heading: 10 },
  { bearing: 180, heading: 0 }, { bearing: 0, heading: 180 },
  { bearing: 90, heading: 90 },
]

const FRESHNESS_CASES = [0, 60, 61, 300, 600, 601, 5000]

const target = (lat: number, u = 2.4, age = 5): NonNullable<RadarInput['target']> =>
  ({ position: { lat, lon: 0 }, uncertaintyMetres: u, ageSeconds: age })

// One case per guidance state and cue tier (see src/radar.test.ts for the
// behavioural intent of each). Cases 0..16 are the v1 set; 17..19 exercise the
// v2 my-accuracy honesty gate + arrival rework (append-only so the Kotlin
// parity test's positional reads stay valid).
const GUIDANCE_CASES: RadarInput[] = [
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: null },
  { me: null, headingDeg: 0, target: target(0.01) },
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.01, 2.4, 700) }, // stale
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.05, 610) }, // coarse far
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.001, 610) }, // coarse inside
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.01, 610) }, // coarse mid
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.000015) }, // arrived (~1.7 m endgame)
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.00005) }, // point deep in the old dead zone (~5.5 m)
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.00015, 19) }, // arrived by uncertainty
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.0002, 19) }, // point, bearing not usable
  { me: { lat: 0, lon: 0 }, headingDeg: null, target: target(0.01) }, // no-heading far
  { me: { lat: 0, lon: 0 }, headingDeg: null, target: target(0.0005) }, // no-heading close
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.0005) }, // aligned close → triple
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.01) }, // aligned far → double
  { me: { lat: 0, lon: 0 }, headingDeg: 45, target: target(0.01) }, // near
  { me: { lat: 0, lon: 0 }, headingDeg: 150, target: target(0.01) }, // off
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.01, 2.4, 300) }, // aging
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.0001), myAccuracyMetres: 15 }, // arrived by MY accuracy (~11 m, radius 12)
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.00008), myAccuracyMetres: 9 }, // point, MY bad fix voids the bearing (~8.8 m)
  { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.01), myAccuracyMetres: 5 }, // point aligned — accuracy present but not limiting
]

// v2 heading engine — compass-vs-course arbitration by speed.
const HEADING_CASES: HeadingInput[] = [
  { compassDeg: 90, compassUsable: true, courseDeg: 200, speedMps: 8 },     // fast → course
  { compassDeg: 90, compassUsable: true, courseDeg: null, speedMps: 8 },    // fast, no course → none
  { compassDeg: 90, compassUsable: true, courseDeg: 200, speedMps: 0.2 },   // slow → compass
  { compassDeg: 90, compassUsable: false, courseDeg: 200, speedMps: 0.2 },  // slow, compass unusable → course
  { compassDeg: null, compassUsable: false, courseDeg: null, speedMps: 0.2 }, // slow, nothing → none
  { compassDeg: 100, compassUsable: true, courseDeg: 110, speedMps: 2 },    // mid, compass agrees → compass
  { compassDeg: 100, compassUsable: true, courseDeg: 200, speedMps: 2 },    // mid, compass disagrees → course + unreliable
  { compassDeg: null, compassUsable: true, courseDeg: 200, speedMps: 2 },   // mid, no compass → course
  { compassDeg: 45, compassUsable: true, courseDeg: null, speedMps: null },  // no speed (→0) → compass
]

// v2 mode machine — VECTOR / SEEK / HOMING with hysteresis.
const MODE_CASES: ModeInput[] = [
  { prevMode: 'seek', distanceMetres: 500, speedMps: 1, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 2.4 },   // seek
  { prevMode: 'seek', distanceMetres: 20, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 2.4 },    // enter homing
  { prevMode: 'homing', distanceMetres: 35, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 2.4 },  // homing holds (hysteresis)
  { prevMode: 'homing', distanceMetres: 45, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 2.4 },  // homing exits
  { prevMode: 'seek', distanceMetres: 20, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 80 },     // coarse never homing
  { prevMode: 'seek', distanceMetres: 5000, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 2.4 },  // enter vector by distance
  { prevMode: 'seek', distanceMetres: 800, speedMps: 6, fastForSec: 6, slowForSec: 0, uncertaintyMetres: 2.4 },   // enter vector by sustained speed
  { prevMode: 'vector', distanceMetres: 800, speedMps: 3, fastForSec: 0, slowForSec: 3, uncertaintyMetres: 2.4 }, // vector holds (not yet slow-sustained)
  { prevMode: 'vector', distanceMetres: 800, speedMps: 0, fastForSec: 0, slowForSec: 12, uncertaintyMetres: 2.4 }, // vector exits
  { prevMode: 'vector', distanceMetres: 3000, speedMps: 0, fastForSec: 0, slowForSec: 12, uncertaintyMetres: 2.4 }, // vector holds (still far)
  { prevMode: 'vector', distanceMetres: 15, speedMps: 0, fastForSec: 0, slowForSec: 12, uncertaintyMetres: 2.4 }, // endgame beats vehicle → homing
]

const PAN_CASES = [-180, -90, -45, 0, 30, 90, 135, null]
const SIGN_CASES = [null, 0, 5, 8, 9, -9, 45, -90, 180]
const TREND_CASES = [null, -0.8, -0.5, -0.1, 0.1, 0.5, 0.8]
const DIRECTION_PHRASE_CASES = [null, 0, 10, 45, -45, 90, -90, 135, -135, 175]
const MILESTONE_CASES = [
  { prev: null, next: 900 },
  { prev: 1200, next: 900 },
  { prev: 1200, next: 400 },
  { prev: 600, next: 550 },
  { prev: 300, next: 240 },
  { prev: 120, next: 90 },
  { prev: 90, next: 80 },
]

// v2 mode-specific cues — VECTOR sparse prompt, HOMING continuous geiger cadence
// with the honesty-gated pan/sign and warmer/colder trend.
const CUE_MODE_CASES: { input: RadarInput; ctx: CueContext }[] = [
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 30, target: target(0.05) }, ctx: { mode: 'vector' } }, // vector far, sign left
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 20, target: target(0.00027) }, ctx: { mode: 'homing', closingRateMps: -0.8 } }, // homing far ~30 m, honest, closing
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.000045) }, ctx: { mode: 'homing', closingRateMps: 0.5 } }, // homing near ~5 m, receding
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.00008), myAccuracyMetres: 5 }, ctx: { mode: 'homing', closingRateMps: -0.6 } }, // homing arrow DROPPED (bearing fiction)
  { input: { me: { lat: 0, lon: 0 }, headingDeg: null, target: target(0.00027) }, ctx: { mode: 'homing', closingRateMps: -0.8 } }, // homing, no heading → warmer/colder only
]

const MOVED_CASES = [
  { prev: null, next: { position: { lat: 0, lon: 0 }, uncertaintyMetres: 2.4 } },
  { prev: { position: { lat: 0, lon: 0 }, uncertaintyMetres: 2.4 }, next: { position: { lat: 0.0001, lon: 0 }, uncertaintyMetres: 2.4 } },
  { prev: { position: { lat: 0, lon: 0 }, uncertaintyMetres: 2.4 }, next: { position: { lat: 0.0005, lon: 0 }, uncertaintyMetres: 2.4 } },
  { prev: { position: { lat: 0, lon: 0 }, uncertaintyMetres: 610 }, next: { position: { lat: 0.003, lon: 0 }, uncertaintyMetres: 610 } },
  { prev: { position: { lat: 0, lon: 0 }, uncertaintyMetres: 610 }, next: { position: { lat: 0.011, lon: 0 }, uncertaintyMetres: 610 } },
]

const COURSE_CASES = [
  { prev: { position: { lat: 0, lon: 0 }, atSec: 0 }, next: { position: { lat: 0.0002, lon: 0 }, atSec: 10 } },
  { prev: { position: { lat: 0, lon: 0 }, atSec: 0 }, next: { position: { lat: 0.00002, lon: 0 }, atSec: 10 } },
  { prev: { position: { lat: 0, lon: 0 }, atSec: 10 }, next: { position: { lat: 0.001, lon: 0 }, atSec: 10 } },
]

// Phase 3: BLE RSSI banding — window → band, away from the -60/-80 boundaries.
const BLE_WINDOW_CASES: number[][] = [
  [],                     // empty → null median, null band
  [-55],                  // thin window → null band
  [-55, -58],             // still thin
  [-55, -58, -52],        // immediate
  [-70, -75, -65],        // near
  [-90, -85, -95],        // far
  [-55, -56, -110],       // fade outlier — median holds immediate
  [-62, -58, -64, -59],   // even window, mean-of-middle-two
]

// Phase 3: blend gates + cadence floors against real guidance shapes.
const BLE_ASSIST_CASES: { input: RadarInput; ble: BleProximity }[] = [
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.00027) }, ble: 'immediate' }, // ~30 m precise → blends
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.00027) }, ble: 'far' },       // far band still "usable" (gates only)
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.00027) }, ble: null },        // no band
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.00027, 80) }, ble: 'immediate' }, // coarse share never blends
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.01) }, ble: 'immediate' },    // ~1.1 km — beyond the ceiling
  { input: { me: null, headingDeg: 0, target: target(0.00027) }, ble: 'immediate' },               // no own fix → no distance → no blend
]

// Phase 3: the HOMING cadence blend — cue with a band vs without.
const CUE_BLE_CASES: { input: RadarInput; ctx: CueContext }[] = [
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 20, target: target(0.00027) }, ctx: { mode: 'homing', bleProximity: 'immediate' } }, // ~30 m paced as 3 m
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 20, target: target(0.00027) }, ctx: { mode: 'homing', bleProximity: 'near' } },      // ~30 m paced as 10 m
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 20, target: target(0.00027) }, ctx: { mode: 'homing', bleProximity: 'far' } },       // far band paces nothing
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.00027), myAccuracyMetres: 15 }, ctx: { mode: 'homing', bleProximity: 'immediate' } }, // arrow stays dropped, cadence quickens
  { input: { me: { lat: 0, lon: 0 }, headingDeg: 0, target: target(0.00027, 80) }, ctx: { mode: 'homing', bleProximity: 'immediate' } }, // coarse share unchanged
]

// Direction callouts: boundary-sticky clock hour. Cases sit either side of the
// 15°+hysteresis edges, plus the wrap at 6 and the null re-adoption path.
const CLOCK_STABLE_CASES: { prevHour: number | null; rel: number | null }[] = [
  { prevHour: null, rel: 0 },
  { prevHour: null, rel: 45 },
  { prevHour: 12, rel: 10 },
  { prevHour: 12, rel: 20 },   // inside the sticky band → holds 12
  { prevHour: 12, rel: 22 },   // past it → 1
  { prevHour: 12, rel: -20 },  // symmetric hold
  { prevHour: 12, rel: -22 },  // → 11
  { prevHour: 1, rel: 14 },    // new hour protected by the same band
  { prevHour: 1, rel: 8 },     // → back to 12
  { prevHour: 12, rel: 90 },   // big swing flips immediately
  { prevHour: 6, rel: 170 },   // rear-boundary wrap holds
  { prevHour: 6, rel: -170 },  // …either side
  { prevHour: 6, rel: -150 },  // → 7
  { prevHour: 12, rel: null }, // no bearing → no hour
]

// Phase 3: the BLE hold in the mode machine.
const MODE_BLE_CASES: ModeInput[] = [
  { prevMode: 'homing', distanceMetres: 45, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 2.4, bleProximity: 'near' },      // held past GPS exit
  { prevMode: 'homing', distanceMetres: 45, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 2.4, bleProximity: 'far' },       // far does not hold
  { prevMode: 'homing', distanceMetres: 30, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 30, bleProximity: 'immediate' },  // held through uncertainty collapse
  { prevMode: 'homing', distanceMetres: 60, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 2.4, bleProximity: 'immediate' }, // beyond the ceiling → exits
  { prevMode: 'homing', distanceMetres: 45, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 80, bleProximity: 'immediate' },  // coarse never held
  { prevMode: 'seek', distanceMetres: 45, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 2.4, bleProximity: 'immediate' },   // never a way IN
]

// Radar session (consented cadence lift): the pure consent/clock rules the
// native publisher must match. Cases sit either side of every window edge
// (request TTL, skew, session TTL, the max-TTL cap). NaN clamp behaviour is
// unit-tested per language instead (NaN does not survive JSON).
const SESSION_REQ = { requestId: 'r1', ttlSec: 900, sentAtSec: 1000 } as SessionRequest
const SESSION_TTL_CASES = [900, 999_999, 3600, 0, -5]
const SESSION_OPEN_CASES = [900, 970, 1000, 1120, 1150, 1151]
const SESSION_SUPERSEDE_CASES: { prev: SessionRequest | null; next: SessionRequest }[] = [
  { prev: null, next: SESSION_REQ },
  { prev: SESSION_REQ, next: { requestId: 'r2', ttlSec: 900, sentAtSec: 1050 } },
  { prev: { requestId: 'r2', ttlSec: 900, sentAtSec: 1050 }, next: SESSION_REQ },
  { prev: SESSION_REQ, next: { requestId: 'r2', ttlSec: 900, sentAtSec: 1000 } },
]
const SESSION_ACCEPT_CASES: { req: SessionRequest; nowSec: number }[] = [
  { req: SESSION_REQ, nowSec: 1060 },
  { req: { requestId: 'r1', ttlSec: 999_999, sentAtSec: 1000 }, nowSec: 1060 },
  { req: SESSION_REQ, nowSec: 5000 },
]
const SESSION_LIVE = { sessionId: 'r1', ttlSec: 900, startAtSec: 1000 } as RadarSession
const SESSION_ACTIVE_CASES: { s: RadarSession; nowSec: number }[] = [
  { s: SESSION_LIVE, nowSec: 1000 },
  { s: SESSION_LIVE, nowSec: 969 },
  { s: SESSION_LIVE, nowSec: 1900 },
  { s: SESSION_LIVE, nowSec: 1930 },
  { s: SESSION_LIVE, nowSec: 1931 },
  { s: { sessionId: 'r1', ttlSec: 999_999, startAtSec: 1000 }, nowSec: 4600 },
  { s: { sessionId: 'r1', ttlSec: 999_999, startAtSec: 1000 }, nowSec: 4631 },
]
const SESSION_REMAINING_CASES: { s: RadarSession; nowSec: number }[] = [
  { s: SESSION_LIVE, nowSec: 1000 },
  { s: SESSION_LIVE, nowSec: 1899.5 },
  { s: SESSION_LIVE, nowSec: 5000 },
]

function build(): Record<string, unknown> {
  return {
    bearing: BEARING_CASES.map((c) => ({ ...c, expected: initialBearingDeg(c.a, c.b) })),
    angularError: ANGULAR_CASES.map((c) => ({ ...c, expected: angularErrorDeg(c.bearing, c.heading) })),
    freshness: FRESHNESS_CASES.map((age) => ({ age, expected: classifyFreshness(age) })),
    guidance: GUIDANCE_CASES.map((input) => {
      const g = radarGuidance(input)
      return { input, guidance: g, cue: cueFor(g) }
    }),
    heading: HEADING_CASES.map((input) => ({ input, expected: resolveHeading(input) })),
    mode: MODE_CASES.map((input) => ({ input, expected: selectMode(input) })),
    pan: PAN_CASES.map((rel) => ({ rel, expected: panFor(rel) })),
    sign: SIGN_CASES.map((rel) => ({ rel, expected: turnSign(rel) })),
    trend: TREND_CASES.map((rate) => ({ rate, expected: classifyTrend(rate) })),
    directionPhrase: DIRECTION_PHRASE_CASES.map((rel) => ({ rel, expected: vectorDirectionPhrase(rel) })),
    milestone: MILESTONE_CASES.map((c) => ({ ...c, expected: crossedMilestone(c.prev, c.next) })),
    cueModes: CUE_MODE_CASES.map(({ input, ctx }) => {
      const g = radarGuidance(input)
      return { input, ctx, guidance: g, cue: cueFor(g, ctx) }
    }),
    moved: MOVED_CASES.map((c) => ({ ...c, expected: targetMoved(c.prev, c.next) })),
    course: COURSE_CASES.map((c) => ({ ...c, expected: courseFromFixes(c.prev, c.next) })),
    bleProximity: BLE_WINDOW_CASES.map((samples) => ({
      samples,
      median: medianRssi(samples),
      expected: bleProximityFromRssi(samples),
    })),
    bleAssist: BLE_ASSIST_CASES.map(({ input, ble }) => {
      const g = radarGuidance(input)
      return { input, ble, usable: bleAssistUsable(g, ble), floorMetres: bleCadenceFloorMetres(ble) }
    }),
    cueBle: CUE_BLE_CASES.map(({ input, ctx }) => {
      const g = radarGuidance(input)
      return { input, ctx, guidance: g, cue: cueFor(g, ctx) }
    }),
    modeBle: MODE_BLE_CASES.map((input) => ({ input, expected: selectMode(input) })),
    clockStable: CLOCK_STABLE_CASES.map((c) => ({ ...c, expected: stableClockHour(c.prevHour, c.rel) })),
    session: {
      ttl: SESSION_TTL_CASES.map((ttlSec) => ({ ttlSec, expected: clampTtlSec(ttlSec) })),
      open: SESSION_OPEN_CASES.map((nowSec) => ({ req: SESSION_REQ, nowSec, expected: requestOpen(SESSION_REQ, nowSec) })),
      supersede: SESSION_SUPERSEDE_CASES.map((c) => ({ ...c, expected: supersedes(c.prev, c.next) })),
      accept: SESSION_ACCEPT_CASES.map((c) => ({ ...c, expected: acceptSession(c.req, c.nowSec) })),
      active: SESSION_ACTIVE_CASES.map((c) => ({ ...c, expected: sessionActive(c.s, c.nowSec) })),
      remaining: SESSION_REMAINING_CASES.map((c) => ({ ...c, expected: sessionRemainingSec(c.s, c.nowSec) })),
      cadence: [true, false].map((moving) => ({ moving, expected: sessionCadenceSec(moving) })),
    },
  }
}

describe('native radar golden vectors', () => {
  it('generates or verifies radar-vectors.json', () => {
    const fresh = build()
    if (process.env.FLOCK_GEN_VECTORS === '1' || !existsSync(OUT)) {
      writeFileSync(OUT, JSON.stringify(fresh, null, 2) + '\n')
    }
    // The committed vectors must still match the live JS implementation —
    // a rule change without a deliberate regeneration fails here first.
    const committed = JSON.parse(readFileSync(OUT, 'utf8'))
    expect(committed).toEqual(JSON.parse(JSON.stringify(fresh)))
  })
})
