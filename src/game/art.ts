// Asset loading + tile compositing. Mirrors ArtFactory.swift's tile treatment
// (mirrored grass variants, darkened path edges facing grass).

import { C } from './config'
import type { EnemyKind, TowerKind } from './config'

export const SPRITE_NAMES = [
  'b_ballista_1', 'b_ballista_2', 'b_ballista_3',
  'b_cannon_1', 'b_cannon_2', 'b_cannon_3',
  'b_flame_1', 'b_flame_2', 'b_flame_3',
  'b_frost_1', 'b_frost_2', 'b_frost_3',
  'b_tesla_1', 'b_tesla_2', 'b_tesla_3',
  'b_lance_1', 'b_lance_2', 'b_lance_3',
  'b_mortar_1', 'b_mortar_2', 'b_mortar_3',
  'b_beacon_1', 'b_beacon_2', 'b_beacon_3',
  'en_boss', 'en_brute', 'en_grunt', 'en_runner', 'en_armored',
  'walk_boss_1', 'walk_boss_2', 'walk_boss_3', 'walk_boss_4',
  'walk_brute_1', 'walk_brute_2', 'walk_brute_3', 'walk_brute_4',
  'walk_grunt_1', 'walk_grunt_2', 'walk_grunt_3', 'walk_grunt_4',
  'walk_runner_1', 'walk_runner_2', 'walk_runner_3', 'walk_runner_4',
  'walk_armored_1', 'walk_armored_2', 'walk_armored_3', 'walk_armored_4',
  'nat_bush', 'nat_pine', 'nat_rock', 'nat_tree',
  'gate_castle', 'gate_portal',
  'tile2_grass', 'tile2_path',
  'spr_ui_coin', 'spr_ui_heart',
]

const images = new Map<string, HTMLImageElement>()
let loaded = false

export const spriteURL = (name: string) => `${import.meta.env.BASE_URL}sprites/${name}.webp`

function load(name: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      images.set(name, img)
      resolve()
    }
    img.onerror = () => resolve()
    img.src = spriteURL(name)
  })
}

export async function loadArt(onProgress?: (p: number) => void): Promise<void> {
  if (loaded) {
    onProgress?.(1)
    return
  }
  let done = 0
  await Promise.all(
    SPRITE_NAMES.map((n) =>
      load(n).then(() => {
        done++
        onProgress?.(done / SPRITE_NAMES.length)
      }),
    ),
  )
  loaded = true
}

export const img = (name: string) => images.get(name) ?? null

export const building = (kind: TowerKind, level: number) =>
  img(`b_${kind}_${Math.max(1, Math.min(3, level))}`)

/**
 * Extra draw size for towers whose weapon hangs out over the sides.
 *
 * A tower is drawn to a fixed width, so the stone base only gets whatever
 * fraction of the sprite the weapon leaves it. A lance sticks its harpoon out
 * sideways and a mortar its barrel, which squeezed their keeps to 48px and 43px
 * against the 53px every other tower sits at — they read as smaller buildings
 * on the same tile.
 *
 * Cropping the overhang would fix the ratio by sawing the weapon off, so the
 * sprite is drawn larger instead: the base lands level with the rest and the
 * weapon is allowed to overhang, which is what it is meant to do.
 *
 * Presentation only. Nothing here reaches the simulation, so a replay is
 * unaffected by it.
 */
const DRAW_SCALE: Partial<Record<TowerKind, number>> = {
  lance: 1.11,
  mortar: 1.22,
}

export const towerDrawScale = (kind: TowerKind) => DRAW_SCALE[kind] ?? 1

export function walkFrames(kind: EnemyKind): HTMLImageElement[] | null {
  const out: HTMLImageElement[] = []
  for (let i = 1; i <= 4; i++) {
    const f = img(`walk_${kind}_${i}`)
    if (f) out.push(f)
  }
  return out.length >= 2 ? out : null
}

export const character = (kind: EnemyKind) => img(`en_${kind}`)

// MARK: - Tiles

const TILE_PX = 128
const tileCache = new Map<string, HTMLCanvasElement>()

function makeTile(id: string, draw: (g: CanvasRenderingContext2D, s: number) => void) {
  const hit = tileCache.get(id)
  if (hit) return hit
  const cv = document.createElement('canvas')
  cv.width = TILE_PX
  cv.height = TILE_PX
  const g = cv.getContext('2d')!
  draw(g, TILE_PX)
  tileCache.set(id, cv)
  return cv
}

/** Four calm grass variants produced by mirroring the source tile. */
export function grassTile(variant: number): HTMLCanvasElement {
  const v = ((variant % 4) + 4) % 4
  return makeTile(`grass${v}`, (g, s) => {
    const src = img('tile2_grass')
    if (src) {
      g.save()
      if (v % 2 === 1) {
        g.translate(s, 0)
        g.scale(-1, 1)
      }
      if (v >= 2) {
        g.translate(0, s)
        g.scale(1, -1)
      }
      g.drawImage(src, 0, 0, s, s)
      g.restore()
    } else {
      g.fillStyle = v % 2 === 0 ? '#9ec470' : '#98be6a'
      g.fillRect(0, 0, s, s)
    }
    // subtle cell grid, same as the iOS build
    g.fillStyle = 'rgba(0,0,0,0.05)'
    g.fillRect(0, s - 2, s, 2)
    g.fillRect(s - 2, 0, 2, s)
  })
}

export const EDGE = { top: 1, bottom: 2, left: 4, right: 8 }

export function pathTile(edges: number): HTMLCanvasElement {
  return makeTile(`path${edges}`, (g, s) => {
    const src = img('tile2_path')
    if (src) g.drawImage(src, 0, 0, s, s)
    else {
      g.fillStyle = '#e0c28d'
      g.fillRect(0, 0, s, s)
    }
    g.fillStyle = 'rgba(196,163,108,0.55)'
    const e = (3.5 / C.cell) * s
    if (edges & EDGE.top) g.fillRect(0, 0, s, e)
    if (edges & EDGE.bottom) g.fillRect(0, s - e, s, e)
    if (edges & EDGE.left) g.fillRect(0, 0, e, s)
    if (edges & EDGE.right) g.fillRect(s - e, 0, e, s)
  })
}

// MARK: - Drawing helpers

/**
 * Draw a sprite anchored like SpriteKit: `ax`/`ay` are fractions of the sprite
 * measured from its bottom-left, and (x, y) is where that anchor lands.
 */
export function drawAnchored(
  g: CanvasRenderingContext2D,
  image: CanvasImageSource,
  x: number,
  y: number,
  w: number,
  h: number,
  ax = 0.5,
  ay = 0.5,
  flipX = false,
) {
  const left = x - w * ax
  const top = y - h * (1 - ay)
  if (flipX) {
    g.save()
    g.translate(left + w / 2, 0)
    g.scale(-1, 1)
    g.drawImage(image, -w / 2, top, w, h)
    g.restore()
  } else {
    g.drawImage(image, left, top, w, h)
  }
}

/** Soft radial blob — the web stand-in for Art.softCircle. */
export function softEllipse(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  alpha: number,
) {
  g.save()
  g.globalAlpha = alpha
  g.translate(x, y)
  g.scale(1, h / w)
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, w / 2)
  grad.addColorStop(0, color)
  grad.addColorStop(0.55, color)
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad
  g.beginPath()
  g.arc(0, 0, w / 2, 0, Math.PI * 2)
  g.fill()
  g.restore()
}

/** Chunky outlined text — the game's comic-style voice. */
export function outlinedText(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  fill: string,
  strokeWidth = size * 0.13,
) {
  g.save()
  g.font = `800 ${size}px "Baloo 2", system-ui, sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.lineJoin = 'round'
  g.miterLimit = 2
  g.lineWidth = strokeWidth
  g.strokeStyle = '#2b2e3a'
  g.strokeText(text, x, y)
  g.fillStyle = fill
  g.fillText(text, x, y)
  g.restore()
}
