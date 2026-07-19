import { describe, it, expect } from 'vitest'
import { deriveGroupKey, encryptEnvelope } from 'canary-kit/sync'
import {
  buildBuzzSignal,
  decryptBuzz,
  BUZZ_SIGNAL_TYPE,
  type Buzz,
} from './buzz.js'

const SEED = '0000000000000000000000000000000000000000000000000000000000000001'
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

async function encrypted(payload: Record<string, unknown>): Promise<string> {
  return encryptEnvelope(deriveGroupKey(SEED), JSON.stringify(payload))
}

describe('buildBuzzSignal / decryptBuzz — structured group signals', () => {
  it('round-trips a provider-defined group action', async () => {
    const event = await buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: A, action: 'on_my_way', timestamp: 42 })
    expect(event.kind).toBe(20_078)
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(BUZZ_SIGNAL_TYPE)

    const back = await decryptBuzz(SEED, event.content)
    expect(back).toEqual<Buzz>({ from: A, action: 'on_my_way', reason: 'On my way', timestamp: 42 })
  })

  it('turns Check in into a location ask without accepting a caller-defined ask', async () => {
    const event = await buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: A, action: 'check_in', timestamp: 9 })
    const back = await decryptBuzz(SEED, event.content)
    expect(back).toMatchObject({ action: 'check_in', reason: 'Check in', ask: 'location' })
  })

  it('round-trips the one targeted system action used to ring a lost phone', async () => {
    const event = await buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: A, action: 'ring_lost_phone', target: B, timestamp: 7 })
    expect(await decryptBuzz(SEED, event.content)).toMatchObject({
      from: A,
      action: 'ring_lost_phone',
      reason: '🔔 Ringing to find this phone',
      target: B,
    })
  })

  it('rejects targeting an ordinary group action and requires a target for ring', async () => {
    await expect(buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: A, action: 'on_my_way', target: B })).rejects.toThrow()
    await expect(buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: A, action: 'ring_lost_phone' })).rejects.toThrow()
  })

  it('accepts only exact known legacy shortcut labels', async () => {
    const known = await encrypted({ from: A, reason: 'On my way', timestamp: 1 })
    expect(await decryptBuzz(SEED, known)).toMatchObject({ action: 'on_my_way', reason: 'On my way' })

    const arbitrary = await encrypted({ from: A, reason: 'meet behind the station', timestamp: 1 })
    await expect(decryptBuzz(SEED, arbitrary)).rejects.toThrow(/action/i)

    const link = await encrypted({ from: A, reason: 'https://example.com', timestamp: 1 })
    await expect(decryptBuzz(SEED, link)).rejects.toThrow(/action/i)
  })

  it('rejects a mismatched compatibility label instead of displaying it', async () => {
    const content = await encrypted({ from: A, action: 'on_my_way', reason: 'anything I want', timestamp: 1 })
    await expect(decryptBuzz(SEED, content)).rejects.toThrow(/label/i)
  })

  it('rejects malformed senders and targets', async () => {
    await expect(buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: 'nope', action: 'on_my_way' })).rejects.toThrow()
    await expect(buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: A, action: 'ring_lost_phone', target: 'nope' })).rejects.toThrow()
  })

  it('a wrong seed cannot decrypt', async () => {
    const event = await buildBuzzSignal({ groupId: 'g', seedHex: SEED, from: A, action: 'on_my_way' })
    await expect(decryptBuzz('f'.repeat(64), event.content)).rejects.toThrow()
  })
})
