// Determinism kit.
//
// For the server to re-check a run, the same seed plus the same inputs has to
// produce the same run everywhere: the player's phone, and Node on the VPS.
// Two things break that by default, and both are handled here.
//
// 1. Randomness. Anything that can change the outcome draws from a seeded
//    stream. Cosmetic randomness (sparks, puffs, bolt jitter) deliberately
//    keeps using Math.random — if it shared this stream, drawing one more spark
//    would shift every later gameplay roll.
//
// 2. Float math. +, -, *, / and sqrt are exactly rounded by IEEE-754, so they
//    agree everywhere. Math.hypot, Math.pow, sin/cos/atan2 are only required to
//    be "implementation-approximated" and may differ between engines, versions
//    and CPUs. So the simulation uses the helpers below instead, and keeps the
//    transcendental ones for drawing only.

const M64 = (1n << 64n) - 1n

/** SplitMix64 — the same generator the maps already use. */
export class Rng {
  private state: bigint

  constructor(seed: bigint) {
    this.state = (seed + 0x9e3779b97f4a7c15n) & M64
  }

  private next64(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & M64
    let z = this.state
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64
    return (z ^ (z >> 31n)) & M64
  }

  /** Integer in [0, bound). */
  int(bound: number): number {
    return bound <= 0 ? 0 : Number(this.next64() % BigInt(bound))
  }

  /** Fisher-Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      const tmp = items[i]
      items[i] = items[j]
      items[j] = tmp
    }
    return items
  }
}

export function randomSeed(): bigint {
  const b = new Uint32Array(2)
  crypto.getRandomValues(b)
  return ((BigInt(b[0]) << 32n) | BigInt(b[1])) & M64
}

/** Distance. sqrt is exactly rounded; Math.hypot is not specified to be. */
export function dist(dx: number, dy: number): number {
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * base^exp for whole exponents, by plain repeated multiplication. Every step is
 * an exactly-rounded IEEE multiply, so the result is identical everywhere —
 * unlike Math.pow. Note this is deliberately NOT exponentiation by squaring:
 * that rounds differently, and the client and server must agree on which.
 */
export function ipow(base: number, exp: number): number {
  let out = 1
  for (let i = 0; i < exp; i++) out *= base
  return out
}
