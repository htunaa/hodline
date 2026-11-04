// Ported from MapGenerator.swift. SplitMix64 uses BigInt so the seeded maps
// come out byte-identical to the iOS build (levels 13-48 depend on it).

import { C } from './config'
import type { LevelDef } from './levels'
import { parseLevelPath } from './levels'

export interface GridPoint {
  x: number
  y: number
}

export const key = (p: GridPoint) => `${p.x},${p.y}`

const M64 = (1n << 64n) - 1n

export class SplitMix64 {
  private state: bigint
  constructor(seed: bigint) {
    this.state = (seed + 0x9e3779b97f4a7c15n) & M64
  }
  next(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & M64
    let z = this.state
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64
    return (z ^ (z >> 31n)) & M64
  }
  bound(b: number): number {
    if (b === 0) return 0
    return Number(this.next() % BigInt(b))
  }
}

export interface GameMap {
  cols: number
  rows: number
  /** Ordered path cells from spawn (top) to exit (bottom). */
  path: GridPoint[]
  pathSet: Set<string>
  /** Blocked decoration cells: key -> 0 rock / 1 tree / 2 bush */
  decor: Map<string, number>
}

export function isBuildable(map: GameMap, p: GridPoint): boolean {
  return (
    p.x >= 0 &&
    p.x < map.cols &&
    p.y >= 0 &&
    p.y < map.rows &&
    !map.pathSet.has(key(p)) &&
    !map.decor.has(key(p))
  )
}

/** Cell center in scene coordinates (origin top-left, y down). */
export function center(p: GridPoint): { x: number; y: number } {
  return { x: (p.x + 0.5) * C.cell, y: (p.y + 0.5) * C.cell }
}

function makeDecor(pathSet: Set<string>, rng: SplitMix64): Map<string, number> {
  const decor = new Map<string, number>()
  const decorCount = 5 + rng.bound(4)
  let attempts = 0
  while (decor.size < decorCount && attempts < 200) {
    attempts++
    const p = { x: rng.bound(C.cols), y: rng.bound(C.rows) }
    if (!pathSet.has(key(p)) && !decor.has(key(p))) {
      decor.set(key(p), rng.bound(3))
    }
  }
  return decor
}

/** Procedural endless map: edge-to-edge serpentine. */
export function generateMap(seed?: bigint): GameMap {
  const s =
    seed ??
    (BigInt(Math.floor(Math.random() * 0x100000000)) << 32n) |
      BigInt(Math.floor(Math.random() * 0x100000000))
  const rng = new SplitMix64(s)
  const cols = C.cols
  const rows = C.rows

  const path: GridPoint[] = []
  let x = rng.bound(cols - 4) + 2
  let y = 0
  path.push({ x, y })
  let goRight = x < cols / 2

  while (y < rows - 1) {
    const target = goRight ? cols - 2 - rng.bound(2) : 1 + rng.bound(2)
    while (x !== target) {
      x += x < target ? 1 : -1
      path.push({ x, y })
    }
    goRight = !goRight
    const down = Math.min(rng.bound(5) === 0 ? 3 : 2, rows - 1 - y)
    for (let i = 0; i < down; i++) {
      y += 1
      path.push({ x, y })
    }
  }

  const pathSet = new Set(path.map(key))
  return { cols, rows, path, pathSet, decor: makeDecor(pathSet, rng) }
}

export function mapForLevel(def: LevelDef): GameMap {
  const authored = parseLevelPath(def)
  if (authored) {
    const rng = new SplitMix64(def.seed)
    const pathSet = new Set(authored.map(key))
    return {
      cols: C.cols,
      rows: C.rows,
      path: authored,
      pathSet,
      decor: makeDecor(pathSet, rng),
    }
  }
  return generateMap(def.seed)
}
