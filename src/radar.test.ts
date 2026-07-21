import { describe, it, expect } from 'vitest'
import {
  RADAR,
  initialBearingDeg,
  angularErrorDeg,
  classifyFreshness,
  radarGuidance,
  cueFor,
  targetMoved,
  courseFromFixes,
  resolveHeading,
  smoothHeadingDeg,
  smoothClosingRate,
  selectMode,
  panFor,
  turnSign,
  classifyTrend,
  vectorDirectionPhrase,
  crossedMilestone,
  voiceLine,
  type RadarInput,
  type TargetObservation,
  type HeadingInput,
  type ModeInput,
} from './radar'

const origin = { lat: 0, lon: 0 }

/** A target observation with sensible defaults, overridable per test. */
function target(over: Partial<TargetObservation> = {}): TargetObservation {
  return { position: { lat: 0.01, lon: 0 }, uncertaintyMetres: 2.4, ageSeconds: 5, ...over }
}

function input(over: Partial<RadarInput> = {}): RadarInput {
  return { me: origin, headingDeg: 0, target: target(), ...over }
}

describe('initialBearingDeg', () => {
  it('points north for a target due north', () => {
    expect(initialBearingDeg(origin, { lat: 1, lon: 0 })).toBeCloseTo(0, 5)
  })

  it('points east for a target due east', () => {
    expect(initialBearingDeg(origin, { lat: 0, lon: 1 })).toBeCloseTo(90, 5)
  })

  it('points south for a target due south', () => {
    expect(initialBearingDeg(origin, { lat: -1, lon: 0 })).toBeCloseTo(180, 5)
  })

  it('points west for a target due west', () => {
    expect(initialBearingDeg(origin, { lat: 0, lon: -1 })).toBeCloseTo(270, 5)
  })

  it('points roughly north-east for a diagonal target', () => {
    expect(initialBearingDeg(origin, { lat: 1, lon: 1 })).toBeCloseTo(45, 0)
  })

  it('rejects an out-of-range coordinate', () => {
    expect(() => initialBearingDeg({ lat: 91, lon: 0 }, origin)).toThrow()
    expect(() => initialBearingDeg(origin, { lat: 0, lon: 181 })).toThrow()
  })
})

describe('angularErrorDeg', () => {
  it('is zero when the phone points straight at the target', () => {
    expect(angularErrorDeg(90, 90)).toBe(0)
  })

  it('is positive when the target is to the right (turn clockwise)', () => {
    expect(angularErrorDeg(30, 0)).toBe(30)
  })

  it('is negative when the target is to the left', () => {
    expect(angularErrorDeg(330, 0)).toBe(-30)
  })

  it('wraps across north: bearing 10 with heading 350 is a small right turn', () => {
    expect(angularErrorDeg(10, 350)).toBe(20)
  })

  it('wraps across north the other way: bearing 350 with heading 10', () => {
    expect(angularErrorDeg(350, 10)).toBe(-20)
  })

  it('a target dead behind reads 180, never -180 or 540', () => {
    expect(angularErrorDeg(180, 0)).toBe(180)
    expect(angularErrorDeg(0, 180)).toBe(180)
  })
})

describe('classifyFreshness', () => {
  it('fresh up to the fresh window', () => {
    expect(classifyFreshness(0)).toBe('fresh')
    expect(classifyFreshness(RADAR.freshSeconds)).toBe('fresh')
  })

  it('aging between fresh and stale', () => {
    expect(classifyFreshness(RADAR.freshSeconds + 1)).toBe('aging')
    expect(classifyFreshness(RADAR.staleSeconds)).toBe('aging')
  })

  it('stale beyond the stale window (matches the app presence window)', () => {
    expect(classifyFreshness(RADAR.staleSeconds + 1)).toBe('stale')
    // The presence UI calls a member stale after 600 s — the radar must agree,
    // or the map and the tracker would tell two different stories.
    expect(RADAR.staleSeconds).toBe(600)
  })
})

describe('radarGuidance — degraded states', () => {
  // SAFETY: no target (not sharing, no beacon yet, private/no-report withheld)
  // must read as unavailable — never a stale pointer to an old spot.
  it('no target → unavailable, with no fabricated distance or bearing', () => {
    const g = radarGuidance(input({ target: null }))
    expect(g.state).toBe('unavailable')
    expect(g.distanceMetres).toBeNull()
    expect(g.bearingDeg).toBeNull()
    expect(g.alignment).toBeNull()
    expect(g.bearingUsable).toBe(false)
  })

  it('no own fix → no-fix, target freshness still reported', () => {
    const g = radarGuidance(input({ me: null }))
    expect(g.state).toBe('no-fix')
    expect(g.distanceMetres).toBeNull()
    expect(g.freshness).toBe('fresh')
    expect(g.bearingUsable).toBe(false)
  })

  // SAFETY: a strong cue to a 5-minute-old target is worse than a degraded cue
  // that admits it — stale wins over everything else.
  it('a stale target → stale, and the bearing is not usable', () => {
    const g = radarGuidance(input({ target: target({ ageSeconds: RADAR.staleSeconds + 60 }) }))
    expect(g.state).toBe('stale')
    expect(g.bearingUsable).toBe(false)
    expect(g.alignment).toBeNull()
    // Distance is still shown (an honest "last seen ~1 km away"), just not guided.
    expect(g.distanceMetres).toBeGreaterThan(0)
  })

  // SAFETY: a coarse share must never be presented as a precise pointer — the
  // cell centre is the grid's position, not the person's (FLOCK §6).
  it('a coarse target (uncertainty above the coarse threshold) → coarse, bearing never usable', () => {
    const g = radarGuidance(input({ target: target({ uncertaintyMetres: 610 }) }))
    expect(g.state).toBe('coarse')
    expect(g.bearingUsable).toBe(false)
    expect(g.alignment).toBeNull()
    expect(g.uncertaintyMetres).toBe(610)
  })

  it('a coarse target is never "point", however close or far', () => {
    for (const lat of [0.0005, 0.01, 0.5]) {
      const g = radarGuidance(input({ target: target({ position: { lat, lon: 0 }, uncertaintyMetres: 610 }) }))
      expect(g.state === 'point' || g.state === 'arrived').toBe(false)
      expect(g.bearingUsable).toBe(false)
    }
  })

  it('no compass heading → no-heading, with distance and bearing but no alignment claim', () => {
    const g = radarGuidance(input({ headingDeg: null }))
    expect(g.state).toBe('no-heading')
    expect(g.distanceMetres).toBeGreaterThan(0)
    expect(g.bearingDeg).not.toBeNull()
    expect(g.relativeBearingDeg).toBeNull()
    expect(g.alignment).toBeNull()
  })
})

describe('radarGuidance — live guidance', () => {
  it('a fresh precise target ahead → point, aligned', () => {
    // ~1.1 km due north, heading north.
    const g = radarGuidance(input())
    expect(g.state).toBe('point')
    expect(g.freshness).toBe('fresh')
    expect(g.bearingUsable).toBe(true)
    expect(g.alignment).toBe('aligned')
    expect(g.relativeBearingDeg).toBeCloseTo(0, 5)
  })

  it('a target off to the side → near / off tiers by angular error', () => {
    const near = radarGuidance(input({ headingDeg: 45 })) // error -45°
    expect(near.alignment).toBe('near')
    const off = radarGuidance(input({ headingDeg: 120 })) // error -120°
    expect(off.alignment).toBe('off')
  })

  it('arrived only in the true endgame (~2 m) of a fresh precise target', () => {
    // ~2.2 m north — within max(arriveMetres, the 2.4 m exact-share cell).
    const g = radarGuidance(input({ target: target({ position: { lat: 0.00002, lon: 0 } }) }))
    expect(g.state).toBe('arrived')
    // The endgame contract: guidance runs down to touching distance, so the
    // last stretch is navigable — not a 15 m "you're here" dead zone.
    expect(RADAR.arriveMetres).toBe(2)
  })

  it('still guiding at 11 m — the radar keeps pointing through the final approach', () => {
    const g = radarGuidance(input({ target: target({ position: { lat: 0.0001, lon: 0 } }) }))
    expect(g.state).toBe('point')
    expect(g.bearingUsable).toBe(true)
  })

  it('arrival radius grows with the target uncertainty (never claims sub-uncertainty precision)', () => {
    // 19 m-uncertain target (building level, still precise-ish) at ~17 m.
    const g = radarGuidance(input({ target: target({ position: { lat: 0.00015, lon: 0 }, uncertaintyMetres: 19 }) }))
    expect(g.state).toBe('arrived')
  })

  it('an aging (heartbeat-old) target still guides, flagged aging', () => {
    const g = radarGuidance(input({ target: target({ ageSeconds: 300 }) }))
    expect(g.state).toBe('point')
    expect(g.freshness).toBe('aging')
  })
})

describe('cueFor — the beep grammar', () => {
  const aligned = cueFor(radarGuidance(input({ target: target({ position: { lat: 0.0005, lon: 0 } }) }))) // ~55 m, aligned
  const alignedFar = cueFor(radarGuidance(input()))                                                       // ~1.1 km, aligned
  const near = cueFor(radarGuidance(input({ headingDeg: 45 })))
  const off = cueFor(radarGuidance(input({ headingDeg: 150 })))
  const stale = cueFor(radarGuidance(input({ target: target({ ageSeconds: 700 }) })))
  const coarse = cueFor(radarGuidance(input({ target: target({ uncertaintyMetres: 610 }) })))
  const unavailable = cueFor(radarGuidance(input({ target: null })))
  const arrived = cueFor(radarGuidance(input({ target: target({ position: { lat: 0.00002, lon: 0 } }) })))

  it('close and aligned → the triple burst', () => {
    expect(aligned.pattern).toBe('triple')
  })

  it('aligned but distant → the confident pair', () => {
    expect(alignedFar.pattern).toBe('double')
  })

  it('correcting → single beeps that slow as the error grows', () => {
    expect(near.pattern).toBe('single')
    expect(off.pattern).toBe('single')
    expect(off.periodMs).toBeGreaterThan(near.periodMs)
  })

  it('the grammar accelerates as you align and approach', () => {
    expect(aligned.periodMs).toBeLessThan(alignedFar.periodMs)
    expect(alignedFar.periodMs).toBeLessThan(near.periodMs)
    expect(near.periodMs).toBeLessThan(off.periodMs)
  })

  it('tone brightens with alignment', () => {
    expect(aligned.toneHz).toBeGreaterThan(near.toneHz)
    expect(near.toneHz).toBeGreaterThan(off.toneHz)
  })

  // SAFETY: stale/coarse/unavailable degrade to a sparse dull pulse — they must
  // never sound like confident guidance (the cue would lie by omission).
  it('stale, coarse and unavailable are all sparse, duller and slower than any live cue', () => {
    for (const c of [stale, coarse, unavailable]) {
      expect(c.pattern).toBe('sparse')
      expect(c.toneHz).toBeLessThan(off.toneHz)
      expect(c.periodMs).toBeGreaterThanOrEqual(off.periodMs)
    }
  })

  it('arrived → immediate silence with a single confirmation haptic', () => {
    expect(arrived.pattern).toBe('silent')
    expect(arrived.vibrateMs.length).toBeGreaterThan(0)
  })

  it('every audible cue has a haptic mirror (works muted, in a loud place)', () => {
    for (const c of [aligned, alignedFar, near, off, stale, coarse, unavailable]) {
      expect(c.vibrateMs.length).toBeGreaterThan(0)
    }
  })

  it('no-heading falls back to a distance-paced pulse (walk-a-few-steps mode)', () => {
    const closeCue = cueFor(radarGuidance(input({ headingDeg: null, target: target({ position: { lat: 0.0005, lon: 0 } }) })))
    const farCue = cueFor(radarGuidance(input({ headingDeg: null })))
    expect(closeCue.pattern).toBe('single')
    expect(closeCue.periodMs).toBeLessThan(farCue.periodMs)
  })

  it('a coarse cue quickens slightly as you close on the disclosed area, but stays sparse', () => {
    const farAway = cueFor(radarGuidance(input({ target: target({ uncertaintyMetres: 610, position: { lat: 0.05, lon: 0 } }) })))
    const inside = cueFor(radarGuidance(input({ target: target({ uncertaintyMetres: 610, position: { lat: 0.001, lon: 0 } }) })))
    expect(farAway.pattern).toBe('sparse')
    expect(inside.pattern).toBe('sparse')
    expect(inside.periodMs).toBeLessThan(farAway.periodMs)
  })
})

describe('targetMoved', () => {
  const at = (lat: number, lon: number, u = 2.4): { position: { lat: number; lon: number }; uncertaintyMetres: number } =>
    ({ position: { lat, lon }, uncertaintyMetres: u })

  it('a first observation is never "moved"', () => {
    expect(targetMoved(null, at(0, 0))).toBe(false)
  })

  it('GPS jitter below the floor is not movement', () => {
    // ~11 m — under the 25 m floor.
    expect(targetMoved(at(0, 0), at(0.0001, 0))).toBe(false)
  })

  it('a real walk between precise fixes is movement', () => {
    // ~55 m.
    expect(targetMoved(at(0, 0), at(0.0005, 0))).toBe(true)
  })

  // SAFETY: a coarse target "moves" only on a change bigger than its own
  // uncertainty — anything less would be reading tea leaves from cell centres.
  it('coarse observations only move when the change exceeds the uncertainty', () => {
    expect(targetMoved(at(0, 0, 610), at(0.003, 0, 610))).toBe(false) // ~330 m < 610 m
    expect(targetMoved(at(0, 0, 610), at(0.011, 0, 610))).toBe(true) // ~1.2 km — a cell change
  })
})

describe('courseFromFixes', () => {
  const fix = (lat: number, lon: number, atSec: number): { position: { lat: number; lon: number }; atSec: number } =>
    ({ position: { lat, lon }, atSec })

  it('a few steps north give a northward course', () => {
    expect(courseFromFixes(fix(0, 0, 0), fix(0.0002, 0, 10))).toBeCloseTo(0, 0)
  })

  it('standing still gives no course (too little movement to trust)', () => {
    expect(courseFromFixes(fix(0, 0, 0), fix(0.00002, 0, 10))).toBeNull()
  })

  it('a zero or negative time step gives no course', () => {
    expect(courseFromFixes(fix(0, 0, 10), fix(0.001, 0, 10))).toBeNull()
    expect(courseFromFixes(fix(0, 0, 10), fix(0.001, 0, 5))).toBeNull()
  })
})

// ── v2: heading engine ───────────────────────────────────────────────────────

describe('resolveHeading — compass distrust', () => {
  const h = (over: Partial<HeadingInput>): HeadingInput =>
    ({ compassDeg: 90, compassUsable: true, courseDeg: 200, speedMps: 0, ...over })

  // SAFETY (Fault 1): in a vehicle the compass is confidently wrong — above the
  // course-speed threshold it is NEVER consulted, only Doppler course.
  it('at vehicle speed the course wins and the compass is ignored', () => {
    const r = resolveHeading(h({ speedMps: 8 }))
    expect(r.source).toBe('course')
    expect(r.headingDeg).toBe(200)
    expect(r.status).toBe('ok')
  })

  it('at vehicle speed with no course we report no heading, never the compass', () => {
    const r = resolveHeading(h({ speedMps: 8, courseDeg: null }))
    expect(r.source).toBeNull()
    expect(r.headingDeg).toBeNull()
    expect(r.status).toBe('none')
  })

  it('near-stationary trusts a platform-usable compass', () => {
    const r = resolveHeading(h({ speedMps: 0.2 }))
    expect(r.source).toBe('compass')
    expect(r.headingDeg).toBe(90)
  })

  it('near-stationary with an unreliable compass falls back to course', () => {
    const r = resolveHeading(h({ speedMps: 0.2, compassUsable: false }))
    expect(r.source).toBe('course')
    expect(r.headingDeg).toBe(200)
  })

  it('mid-band keeps the compass when it agrees with recent course', () => {
    const r = resolveHeading(h({ speedMps: 2, compassDeg: 100, courseDeg: 110 }))
    expect(r.source).toBe('compass')
    expect(r.status).toBe('ok')
  })

  it('mid-band drops a compass that disagrees with course, flagging it unreliable', () => {
    const r = resolveHeading(h({ speedMps: 2, compassDeg: 100, courseDeg: 200 }))
    expect(r.source).toBe('course')
    expect(r.headingDeg).toBe(200)
    expect(r.status).toBe('compass-unreliable')
  })

  it('no usable source at all → honest no-heading', () => {
    const r = resolveHeading(h({ speedMps: 0.2, compassDeg: null, compassUsable: false, courseDeg: null }))
    expect(r.source).toBeNull()
    expect(r.status).toBe('none')
  })
})

describe('smoothHeadingDeg — circular EMA', () => {
  it('adopts the first sample outright', () => {
    expect(smoothHeadingDeg(null, 42, 0.5)).toBe(42)
  })

  it('blends along the SHORTEST arc across north (never the long way)', () => {
    // 350 → 10 is a +20° step; halfway is 0, not 180.
    expect(smoothHeadingDeg(350, 10, 0.5)).toBeCloseTo(0, 6)
  })

  it('alpha 1 is no smoothing', () => {
    expect(smoothHeadingDeg(100, 250, 1)).toBeCloseTo(250, 6)
  })
})

describe('smoothClosingRate — warmer/colder EMA', () => {
  it('adopts the first instantaneous rate', () => {
    // 100 → 90 over 5 s = −2 m/s (closing).
    expect(smoothClosingRate(null, 100, 90, 5, 0.5)).toBeCloseTo(-2, 6)
  })

  it('a non-positive dt holds the previous rate', () => {
    expect(smoothClosingRate(-1, 100, 50, 0, 0.5)).toBe(-1)
  })

  it('eases toward the new instantaneous rate by alpha', () => {
    // prev −1, inst (110−100)/5 = +2 → −1 + 0.5*(2 − −1) = 0.5.
    expect(smoothClosingRate(-1, 100, 110, 5, 0.5)).toBeCloseTo(0.5, 6)
  })
})

// ── v2: mode machine ─────────────────────────────────────────────────────────

describe('selectMode — VECTOR / SEEK / HOMING with hysteresis', () => {
  const m = (over: Partial<ModeInput>): ModeInput =>
    ({ prevMode: 'seek', distanceMetres: 500, speedMps: 0, fastForSec: 0, slowForSec: 0, uncertaintyMetres: 2.4, ...over })

  it('the on-foot middle band is SEEK', () => {
    expect(selectMode(m({}))).toBe('seek')
  })

  it('enters HOMING inside the endgame of a precise target', () => {
    expect(selectMode(m({ distanceMetres: 20 }))).toBe('homing')
  })

  it('a coarse target never gets a HOMING endgame', () => {
    expect(selectMode(m({ distanceMetres: 20, uncertaintyMetres: 80 }))).toBe('seek')
  })

  it('HOMING holds through the hysteresis band and only exits past it', () => {
    expect(selectMode(m({ prevMode: 'homing', distanceMetres: 35 }))).toBe('homing')
    expect(selectMode(m({ prevMode: 'homing', distanceMetres: 45 }))).toBe('seek')
  })

  it('enters VECTOR beyond the far range, or on sustained speed', () => {
    expect(selectMode(m({ distanceMetres: 5000 }))).toBe('vector')
    expect(selectMode(m({ distanceMetres: 800, speedMps: 6, fastForSec: 6 }))).toBe('vector')
  })

  it('VECTOR needs SUSTAINED speed — a brief burst does not enter', () => {
    expect(selectMode(m({ distanceMetres: 800, speedMps: 6, fastForSec: 2 }))).toBe('seek')
  })

  it('VECTOR only exits once slow is sustained AND we are back in range', () => {
    expect(selectMode(m({ prevMode: 'vector', distanceMetres: 800, slowForSec: 3 }))).toBe('vector')
    expect(selectMode(m({ prevMode: 'vector', distanceMetres: 3000, slowForSec: 12 }))).toBe('vector')
    expect(selectMode(m({ prevMode: 'vector', distanceMetres: 800, slowForSec: 12 }))).toBe('seek')
  })

  it('the precise endgame beats the vehicle band', () => {
    expect(selectMode(m({ prevMode: 'vector', distanceMetres: 15, slowForSec: 12 }))).toBe('homing')
  })
})

// ── v2: cue-grammar helpers ──────────────────────────────────────────────────

describe('panFor / turnSign / classifyTrend', () => {
  it('pan is clamped relative bearing over 90', () => {
    expect(panFor(0)).toBe(0)
    expect(panFor(45)).toBeCloseTo(0.5, 6)
    expect(panFor(90)).toBe(1)
    expect(panFor(180)).toBe(1)
    expect(panFor(-90)).toBe(-1)
    expect(panFor(null)).toBe(0)
  })

  it('the sign has an on-beam dead band so left/right never ping-pongs', () => {
    expect(turnSign(0)).toBeNull()
    expect(turnSign(RADAR.signDeadbandDegrees)).toBeNull()
    expect(turnSign(RADAR.signDeadbandDegrees + 1)).toBe('right')
    expect(turnSign(-(RADAR.signDeadbandDegrees + 1))).toBe('left')
    expect(turnSign(null)).toBeNull()
  })

  it('the trend needs a clear closing/receding rate; jitter reads flat', () => {
    expect(classifyTrend(-0.8)).toBe('closing')
    expect(classifyTrend(0.8)).toBe('receding')
    expect(classifyTrend(-0.1)).toBeNull()
    expect(classifyTrend(null)).toBeNull()
  })
})

// ── v2: my-accuracy honesty gate + arrival rework (Fault 4) ───────────────────

describe('radarGuidance — my own fix accuracy (Fault 4)', () => {
  it('a bad fix of MINE voids the bearing exactly like a coarse target', () => {
    // ~8.8 m away, but my fix is ±9 m: pointing would be fiction.
    const g = radarGuidance(input({ target: target({ position: { lat: 0.00008, lon: 0 } }), myAccuracyMetres: 9 }))
    expect(g.state).toBe('point')
    expect(g.bearingUsable).toBe(false)
    expect(g.alignment).toBeNull()
  })

  it('arrival grows with my fix accuracy — "within GPS reach", not orbiting noise', () => {
    // ~11 m away with a ±15 m fix → arrival radius max(2, 2.4, 12) = 12.
    const g = radarGuidance(input({ target: target({ position: { lat: 0.0001, lon: 0 } }), myAccuracyMetres: 15 }))
    expect(g.state).toBe('arrived')
  })

  it('a good fix does not restrict a distant bearing', () => {
    const g = radarGuidance(input({ myAccuracyMetres: 5 }))
    expect(g.state).toBe('point')
    expect(g.bearingUsable).toBe(true)
  })

  it('null accuracy leaves v1 behaviour unchanged', () => {
    const withNull = radarGuidance(input({ myAccuracyMetres: null }))
    const without = radarGuidance(input())
    expect(withNull.state).toBe(without.state)
    expect(withNull.bearingUsable).toBe(without.bearingUsable)
  })
})

// ── v2: cue grammar v2 — pan, sign, trend, modes ──────────────────────────────

describe('cueFor v2 — directional channels', () => {
  it('SEEK point cues carry pan + sign from the relative bearing', () => {
    const right = cueFor(radarGuidance(input({ headingDeg: 315 }))) // target NE of a NW heading → to the right
    expect(right.pan).toBeGreaterThan(0)
    expect(right.sign).toBe('right')
    const left = cueFor(radarGuidance(input({ headingDeg: 45 })))
    expect(left.pan).toBeLessThan(0)
    expect(left.sign).toBe('left')
  })

  // SAFETY: a coarse/stale target still gets the bare sparse pulse — NO pan,
  // NO sign, NO trend. Directional cues only exist when the bearing is usable.
  it('degraded states never carry directional channels', () => {
    for (const g of [
      radarGuidance(input({ target: target({ uncertaintyMetres: 610 }) })), // coarse
      radarGuidance(input({ target: target({ ageSeconds: 700 }) })),        // stale
      radarGuidance(input({ target: null })),                               // unavailable
    ]) {
      const c = cueFor(g)
      expect(c.pan).toBe(0)
      expect(c.sign).toBeNull()
      expect(c.trend).toBeNull()
    }
  })

  it('VECTOR keeps the earcon sparse (voice leads) but still pans', () => {
    const c = cueFor(radarGuidance(input({ headingDeg: 30 })), { mode: 'vector' })
    expect(c.pattern).toBe('single')
    expect(c.periodMs).toBeGreaterThanOrEqual(3000)
    expect(c.sign).toBe('left') // bearing 0, heading 30 → target to the left
  })

  it('HOMING cadence + pitch interpolate continuously with range', () => {
    const far = cueFor(radarGuidance(input({ target: target({ position: { lat: 0.00027, lon: 0 } }) })), { mode: 'homing' }) // ~30 m
    const near = cueFor(radarGuidance(input({ target: target({ position: { lat: 0.000045, lon: 0 } }) })), { mode: 'homing' }) // ~5 m
    expect(near.periodMs).toBeLessThan(far.periodMs)   // quickens as it closes
    expect(near.toneHz).toBeGreaterThan(far.toneHz)    // rises in pitch
  })

  it('HOMING carries the warmer/colder trend note', () => {
    const closing = cueFor(radarGuidance(input({ target: target({ position: { lat: 0.00027, lon: 0 } }) })), { mode: 'homing', closingRateMps: -0.8 })
    expect(closing.trend).toBe('closing')
  })

  // SAFETY (Fault 4): inside ~3× my fix accuracy the me→target bearing is GPS
  // fiction — HOMING DROPS the arrow (pan/sign) and guides by warmer/colder.
  it('HOMING drops the arrow when the bearing is fiction, keeping the trend', () => {
    const c = cueFor(
      radarGuidance(input({ target: target({ position: { lat: 0.00008, lon: 0 } }), myAccuracyMetres: 5 })), // ~8.8 m, 3× acc = 15 m
      { mode: 'homing', closingRateMps: -0.6 },
    )
    expect(c.pan).toBe(0)
    expect(c.sign).toBeNull()
    expect(c.trend).toBe('closing')
  })

  it('every v2 cue still keeps a per-burst haptic mirror', () => {
    for (const c of [
      cueFor(radarGuidance(input()), { mode: 'seek' }),
      cueFor(radarGuidance(input({ headingDeg: 30 })), { mode: 'vector' }),
      cueFor(radarGuidance(input({ target: target({ position: { lat: 0.00027, lon: 0 } }) })), { mode: 'homing' }),
    ]) {
      expect(c.vibrateMs.length).toBeGreaterThan(0)
    }
  })
})

// ── v2: voice-line copy ──────────────────────────────────────────────────────

describe('voice-line copy', () => {
  const fmt = (m: number): string => `${Math.round(m)} m`

  it('direction phrases use plain left/right language', () => {
    expect(vectorDirectionPhrase(0)).toBe('straight ahead')
    expect(vectorDirectionPhrase(45)).toBe('ahead on your right')
    expect(vectorDirectionPhrase(-45)).toBe('ahead on your left')
    expect(vectorDirectionPhrase(90)).toBe('to your right')
    expect(vectorDirectionPhrase(175)).toBe('behind you')
    expect(vectorDirectionPhrase(null)).toBe('ahead')
  })

  it('a milestone announces the deepest band entered, never one sailed past', () => {
    expect(crossedMilestone(1200, 900)).toBe(1000)
    expect(crossedMilestone(1200, 400)).toBe(500) // crossed 1000 and 500 → announce 500
    expect(crossedMilestone(600, 550)).toBeNull()
    expect(crossedMilestone(null, 900)).toBeNull()
  })

  it('a milestone line reads "<distance>, <direction>"', () => {
    const g = radarGuidance(input({ headingDeg: 30 })) // target to the left
    expect(voiceLine({ kind: 'milestone', distanceMetres: 800 }, g, fmt)).toBe('800 m, ahead on your left')
  })

  it('degradations and arrival speak plainly, never a bearing', () => {
    const g = radarGuidance(input())
    expect(voiceLine({ kind: 'arrived' }, g, fmt)).toMatch(/GPS reach/i)
    expect(voiceLine({ kind: 'degraded', state: 'stale' }, g, fmt)).toMatch(/stale/i)
    expect(voiceLine({ kind: 'compass-unreliable' }, g, fmt)).toMatch(/compass unreliable/i)
  })
})
