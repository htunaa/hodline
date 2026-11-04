// Ported from Levels.swift — 12 authored paths + 36 deterministic seeded maps.

import { C } from './config'
import { ipow } from './rng'
import type { GridPoint } from './map'

export interface LevelDef {
  id: number
  startX: number | null
  moves: string | null
  seed: bigint
}

export const LEVEL_COUNT = 48

const AUTHORED: [number, string][] = [
  [1, 'D2 R7 D2 L7 D2 R7 D2 L7 D2 R7 D2 L4 D2'],
  [8, 'D1 L7 D2 R7 D2 L7 D2 R7 D2 L7 D2 R4 D3'],
  [4, 'D2 L3 D2 R7 D2 L7 D3 R7 D2 L4 D3'],
  [2, 'D4 R5 U2 R2 D6 L8 D3 R7 D3'],
  [5, 'D3 L4 D3 R8 D2 L8 D2 R8 D3 L4 D1'],
  [8, 'D2 L4 D3 L3 D3 R7 U2 R1 D8 L4'],
  [1, 'D3 R4 D2 R4 D3 L4 U1 L4 D5 R7 D2 L3'],
  [4, 'D2 R4 D3 L7 D2 R7 D3 L7 D2 R4 D2'],
  [2, 'D2 R6 D3 L6 D2 R6 U1 R1 D5 L7 D3 R4'],
  [5, 'D4 L4 D2 R8 D3 L8 U1 L1 D5 R6 D1'],
  [8, 'D3 L3 D2 L4 D3 R8 D2 L8 D3 R5 D1'],
  [1, 'D2 R4 D2 R4 D3 L8 D2 R8 D3 L5 D2'],
]

export const LEVELS: LevelDef[] = (() => {
  const defs: LevelDef[] = []
  AUTHORED.forEach((a, i) => {
    defs.push({ id: i + 1, startX: a[0], moves: a[1], seed: BigInt((i + 1) * 11) })
  })
  for (let id = 13; id <= LEVEL_COUNT; id++) {
    defs.push({
      id,
      startX: null,
      moves: null,
      seed: (BigInt(id) * 7919n + 104729n) & ((1n << 64n) - 1n),
    })
  }
  return defs
})()

export function level(id: number): LevelDef | null {
  return id >= 1 && id <= LEVELS.length ? LEVELS[id - 1] : null
}

/** Difficulty curve — tuned with the analytic simulator, identical to iOS. */
export const waveTarget = (id: number) => 10 + Math.round(id * 0.35)
export const hpMult = (id: number) => ipow(1.03, id - 1)
export const goldMult = (id: number) => ipow(1.025, id - 1)

export function parseLevelPath(def: LevelDef): GridPoint[] | null {
  if (def.startX === null || def.moves === null) return null
  let x = def.startX
  let y = 0
  const cells: GridPoint[] = [{ x, y }]
  const seen = new Set<string>([`${x},${y}`])
  for (const token of def.moves.split(' ')) {
    const dir = token[0]
    const count = parseInt(token.slice(1), 10)
    if (!count || count <= 0) return null
    let dx = 0
    let dy = 0
    if (dir === 'D') dy = 1
    else if (dir === 'U') dy = -1
    else if (dir === 'R') dx = 1
    else if (dir === 'L') dx = -1
    else return null
    for (let i = 0; i < count; i++) {
      x += dx
      y += dy
      const k = `${x},${y}`
      if (x < 0 || x >= C.cols || y < 0 || y >= C.rows || seen.has(k)) return null
      cells.push({ x, y })
      seen.add(k)
    }
  }
  return y === C.rows - 1 ? cells : null
}
