import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { deriveBeaconKey, decryptBeacon } from 'canary-kit'
import { hashGroupId } from 'canary-kit/nostr'
import { encode } from 'geohash-kit'
import { derive, fromNsec } from 'nsec-tree'
import { decrypt as nip44decrypt, getConversationKey } from 'nostr-tools/nip44'

const vectors = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'vectors.json'), 'utf8'))
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{1,2}/g) ?? [], (value) => Number.parseInt(value, 16))
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')

describe('Flock v1 compatibility vectors', () => {
  it('preserves deterministic derivation and geohash outputs', () => {
    expect(toHex(deriveBeaconKey(vectors.seedHex))).toBe(vectors.beaconKeyHex)
    expect(hashGroupId(vectors.circleId)).toBe(vectors.groupIdHash)
    for (const vector of vectors.geohash) {
      expect(encode(vector.lat, vector.lon, vector.precision)).toBe(vector.expected)
    }

    const root = fromNsec(fromHex(vectors.seedHex))
    for (const vector of vectors.derive) {
      const identity = derive(root, vector.purpose, vector.index)
      expect(toHex(identity.privateKey)).toBe(vector.skHex)
      expect(toHex(identity.publicKey)).toBe(vector.pkHex)
    }
  })

  it('continues to decrypt the committed beacon and NIP-44 samples', async () => {
    for (const vector of vectors.beaconCiphertexts) {
      const payload = await decryptBeacon(deriveBeaconKey(vectors.seedHex), vector.ciphertextB64)
      expect(payload).toEqual({
        geohash: vector.geohash,
        precision: vector.precision,
        timestamp: vector.timestamp,
      })
    }
    for (const vector of vectors.nip44) {
      const plaintext = nip44decrypt(
        vector.ciphertext,
        getConversationKey(fromHex(vector.senderSkHex), vector.recipientPkHex),
      )
      expect(plaintext).toBe(vector.plaintext)
    }
  })
})
