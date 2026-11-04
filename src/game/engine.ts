// Port of GameScene.swift to Canvas 2D. Same simulation, same numbers;
// SKActions are replaced by a small explicit effect list.

import {
  C,
  COMBO,
  EARLY_CALL_SHARE,
  ENEMY,
  TARGET_MODES,
  TOWER_COST,
  aims,
  armorFor,
  completionBonus,
  enemyDef,
  maxTowerLevel,
  towerReadout,
  towerStats,
  upgradeCost,
  wavePlan,
} from './config'
import type { EnemyKind, TargetMode, TowerKind, TowerStatKey, TowerStats, WavePlan } from './config'
import {
  EDGE,
  building,
  character,
  drawAnchored,
  grassTile,
  img,
  outlinedText,
  pathTile,
  softEllipse,
  towerDrawScale,
  walkFrames,
} from './art'
import { goldMult, hpMult, level as levelDef, waveTarget } from './levels'
import type { GameMap, GridPoint } from './map'
import { center, generateMap, isBuildable, key, mapForLevel } from './map'
import { Progress } from './progress'
import { Rng, dist, randomSeed } from './rng'
import { sfx } from './sfx'

export type GameMode = { kind: 'level'; id: number } | { kind: 'endless' }

/** One player action, stamped with the simulation tick it landed on. */
export interface RunAction {
  tick: number
  type: 'place' | 'upgrade' | 'sell' | 'wave' | 'bonus' | 'revive' | 'target'
  x?: number
  y?: number
  kind?: TowerKind
  /** For a target action: who the tower at x,y shoots at from now on. */
  target?: TargetMode
  amount?: number
  /** For a revive: the burn transaction that paid for it, checked by the server. */
  tx?: string
}

/**
 * Everything needed to replay a run from scratch. The server re-runs this and
 * only believes the score if its own simulation agrees.
 */
export interface RunRecord {
  version: number
  seed: string
  mode: 'endless' | 'level'
  levelId: number | null
  ticks: number
  actions: RunAction[]
}

/**
 * What each kind of tower did over the run, and what got through. For the end
 * screen and the share card: "your mortars did 61% of the work, three ogres
 * got past" is how a player learns what to build next time.
 *
 * Only ever written to, never read by the simulation, so it cannot change a
 * run and the replay does not have to agree with anybody about it.
 */
export interface RunStats {
  /** Damage that landed, overkill not counted, and kills, by the tower that dealt them. */
  byTower: Partial<Record<TowerKind, { damage: number; kills: number }>>
  /** Enemies that reached the castle, and the lives they took. */
  leaks: Partial<Record<EnemyKind, { count: number; lives: number }>>
  goldEarned: number
}

/** Simulation step. Fixed, so a slow phone and a fast one run the same run. */
export const TICK = 1 / 60
/**
 * Bumped to 2 for the lance, mortar, beacon and armoured enemies, to 3 for the
 * gentler endless curve past wave 25 and the revive rally, to 4 for the
 * softer endless boss and the 1.12 late curve, and to 5 for target choice and
 * the tower combos (COMBO in config).
 *
 * An older record was produced under different rules, so replaying it here
 * would not reproduce it. The verifier rejects the mismatch rather than
 * re-simulating under today's tables and calling the disagreement cheating.
 */
export const RECORD_VERSION = 5
/**
 * A revive rallies the towers: the wave fought again is fought at this much
 * damage. Without it a revive only refilled the lives, the same board met the
 * same wave, and three revives bought a single wave (measured). Applies to the
 * one wave only; the next is back to normal.
 */
export const REVIVE_RALLY = 1.3
/** Ticks a single frame may simulate. 3x speed needs 3 at 60fps, 9 at 20fps. */
const MAX_TICKS_PER_FRAME = 20
export type Phase = 'interlude' | 'fighting' | 'gameOver' | 'victory'

export interface SelectedTowerInfo {
  kind: TowerKind
  level: number
  upgradeCost: number | null
  sellValue: number
  statKey: TowerStatKey
  statArgs: number[]
  /** Who it shoots at. Null for the towers that do not aim (see `aims`). */
  target: TargetMode | null
}

export interface HudState {
  gold: number
  lives: number
  wave: number
  waveTarget: number | null
  phase: Phase
  interlude: number
  speed: number
  autoWave: boolean
  palette: TowerKind | null
  selected: SelectedTowerInfo | null
  kills: number
  bestWave: number
  victoryStars: number
  towersBuilt: number
  upgradesDone: number
  /** Revives bought this run. Each costs twice the one before. */
  revives: number
  /**
   * What calling the next wave now would pay on top, while the current one is
   * still on the field; null while it cannot be called (see canCallEarly).
   */
  callBonus: number | null
}

interface Enemy {
  kind: EnemyKind
  x: number
  y: number
  hp: number
  maxHP: number
  /** Subtracted from every hit that is not piercing. 0 for everything soft. */
  armor: number
  gold: number
  nextWaypoint: number
  progress: number
  slow: number
  /** Seconds of flame left on it: if it dies while burning it explodes. */
  burn: number
  /** Seconds left of armour cracked by a mortar shell: hits land in full. */
  shred: number
  animT: number
  spawnT: number
  faceRight: boolean
  damaged: boolean
  height: number
  /** The wave it came with. Two waves can share the field. */
  wave: number
}

interface Tower {
  kind: TowerKind
  level: number
  cell: GridPoint
  x: number
  y: number
  cooldown: number
  invested: number
  pop: number
  target: TargetMode
}

interface Projectile {
  x: number
  y: number
  tx: number
  ty: number
  target: Enemy | null
  speed: number
  damage: number
  splash: number
  /** Lobbed rather than fired flat: cannon and mortar. Drives the arc and the sound. */
  cannon: boolean
  pierce: boolean
  angle: number
  /** Which kind of tower fired it, for the run's stats. */
  by: TowerKind
}

type FX =
  | { t: number; type: 'banner'; dur: number; text: string; color: string; sub?: string }
  | { t: number; type: 'float'; dur: number; text: string; color: string; x: number; y: number; small: boolean; drift: number }
  | { t: number; type: 'boom'; dur: number; x: number; y: number; radius: number; parts: { a: number; d: number; s: number }[] }
  | { t: number; type: 'spark'; dur: number; x: number; y: number }
  | { t: number; type: 'puff'; dur: number; x: number; y: number; parts: { a: number; d: number; s: number }[] }
  | { t: number; type: 'frost'; dur: number; x: number; y: number; range: number }
  | { t: number; type: 'flame'; dur: number; x: number; y: number; dx: number; dy: number; hue: number }
  | { t: number; type: 'bolt'; dur: number; pts: { x: number; y: number }[] }
  | { t: number; type: 'leak'; dur: number }
  | { t: number; type: 'ring'; dur: number; x: number; y: number; radius: number; color: string }
  | { t: number; type: 'muzzle'; dur: number; x: number; y: number }

/** Cosmetic jitter only — never call this from anything that decides the run. */
const rand = (a: number, b: number) => a + Math.random() * (b - a)

export class Engine {
  readonly mode: GameMode
  readonly map: GameMap
  private canvas: HTMLCanvasElement | null
  private g: CanvasRenderingContext2D | null
  /** No canvas: the server re-simulating a run. Same code, no drawing. */
  private readonly headless: boolean
  private waypoints: { x: number; y: number }[]

  private towers = new Map<string, Tower>()
  private enemies: Enemy[] = []
  private projectiles: Projectile[] = []
  private fx: FX[] = []

  private spawnQueue: EnemyKind[] = []
  private spawnTimer = 0
  private plan: WavePlan | null = null
  private interludeRemaining: number = C.interludeFirst
  private fighting = false
  private over = false

  private readonly seed: bigint
  private readonly rng: Rng
  /** Simulation ticks elapsed. Actions are stamped with it, so a replay can
   *  apply them at exactly the same moment. */
  private tickCount = 0
  /** The wave a revive is fighting again, at REVIVE_RALLY damage. */
  private rallyWave = -1
  private accumulator = 0
  private actions: RunAction[] = []
  /**
   * The target last chosen for each kind of tower, which a new one of that
   * kind starts with. Ten lances should not take ten clicks to point at the
   * boss. Set only by setTargetAt, so a replay arrives at the same value.
   */
  private lastTarget: Partial<Record<TowerKind, TargetMode>> = {}
  /** See RunStats. Public to read, written only by the simulation. */
  readonly stats: RunStats = { byTower: {}, leaks: {}, goldEarned: 0 }

  private raf = 0
  private lastTime = 0
  /** Drives cosmetic pulses (overcharge aura). */
  private clock = 0
  private terrain: HTMLCanvasElement | null = null
  private scale = 1

  // interaction
  private ghostCell: GridPoint | null = null
  private selectedCell: string | null = null
  private pointerInside = false

  // published state
  state: HudState
  onState: (s: HudState) => void = () => {}
  onEnd: (s: HudState) => void = () => {}
  private emitAccum = 0

  constructor(
    canvas: HTMLCanvasElement | null,
    mode: GameMode,
    bonusGold = 0,
    seed: bigint = randomSeed(),
  ) {
    this.canvas = canvas
    this.headless = canvas === null
    this.mode = mode
    this.seed = seed
    this.rng = new Rng(seed)
    this.g = canvas ? canvas.getContext('2d') : null
    this.map =
      mode.kind === 'level' ? mapForLevel(levelDef(mode.id) ?? levelDef(1)!) : generateMap(seed)
    this.waypoints = this.map.path.map(center)
    this.state = {
      gold: C.startGold,
      lives: C.startLives,
      wave: 0,
      waveTarget: mode.kind === 'level' ? waveTarget(mode.id) : null,
      phase: 'interlude',
      interlude: C.interludeFirst,
      speed: 1,
      autoWave: true,
      palette: null,
      selected: null,
      kills: 0,
      bestWave: Progress.bestWave,
      victoryStars: 0,
      towersBuilt: 0,
      upgradesDone: 0,
      revives: 0,
      callBonus: null,
    }
    if (!this.headless) {
      this.buildTerrain()
      this.bindInput()
    }
    this.grantBonus(bonusGold)
  }

  private bonusGranted = 0

  /** Total holder bonus handed over so far — grantBonus is idempotent by it. */
  get bonusTotal() {
    return this.bonusGranted
  }

  /**
   * Holder starting-gold perk. Idempotent by total, because the wallet balance
   * resolves asynchronously — a holder who hits Play before their balance lands
   * still gets the bonus, a moment into the run, instead of silently losing it.
   */
  grantBonus(total: number) {
    const add = Math.floor(Math.max(0, total)) - this.bonusGranted
    if (add <= 0) return
    this.bonusGranted += add
    this.state.gold += add
    if (!this.headless) this.actions.push({ tick: this.tickCount, type: 'bonus', amount: add })
    this.fx.push({
      t: 0,
      type: 'banner',
      dur: 2.2,
      text: `+${add} HOLDER BONUS`,
      color: '#ffd94d',
    })
    this.emit()
  }

  // MARK: - Lifecycle

  start() {
    this.lastTime = 0
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick)
      const t = now / 1000
      if (!this.lastTime) {
        this.lastTime = t
        this.render()
        return
      }
      const dt = Math.min(t - this.lastTime, 0.25)
      this.lastTime = t
      if (!this.over) {
        // The break between waves runs at 1x whatever the speed: it is for
        // planning and for calling the next wave early, and at 5x it was
        // gone in two seconds. Only how fast ticks are played changes, not
        // what they do, so a replay is unaffected.
        this.accumulator += dt * (this.fighting ? this.state.speed : 1)
        // Bounded work per frame. A frame can otherwise owe up to 45 ticks
        // (0.25s of stalled time at 3x), and on a weak phone with a full board
        // that is long enough to blow the frame budget — which then accrues
        // even more time, and the game slides into a spiral. Capping turns the
        // worst case into brief slow-motion instead, which is the right way to
        // fail. Dropped time is dropped on the server too, since a replay only
        // ever runs the ticks that were actually recorded.
        let steps = 0
        // Stops the moment the run ends, mid-frame included. The replay stops
        // there too (`step` is a no-op once over), so a tick counted after the
        // death would put a revive stamped on it somewhere the replay never
        // reaches.
        while (this.accumulator >= TICK && steps < MAX_TICKS_PER_FRAME && !this.over) {
          this.simulate(TICK)
          this.tickCount += 1
          this.accumulator -= TICK
          steps += 1
        }
        if (steps >= MAX_TICKS_PER_FRAME) this.accumulator = 0
      }
      this.render()
      this.emitAccum += dt
      if (this.emitAccum > 0.1) {
        this.emitAccum = 0
        this.emit()
      }
    }
    this.raf = requestAnimationFrame(tick)
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    this.unbindInput()
  }

  get isOver() {
    return this.over
  }

  /** Advance exactly one tick. A replay's only clock. */
  step() {
    if (this.over) return
    this.simulate(TICK)
    this.tickCount += 1
  }

  /** Place by cell, bypassing pointer handling. */
  placeAt(kind: TowerKind, cell: GridPoint): boolean {
    if (!this.canPlace(kind, cell)) return false
    this.place(kind, cell)
    return true
  }

  /** The towers standing now, by kind: how many, their highest level, the gold in them. */
  board(): Partial<Record<TowerKind, { count: number; topLevel: number; invested: number }>> {
    const out: Partial<Record<TowerKind, { count: number; topLevel: number; invested: number }>> = {}
    for (const t of this.towers.values()) {
      const b = (out[t.kind] ??= { count: 0, topLevel: 0, invested: 0 })
      b.count += 1
      b.topLevel = Math.max(b.topLevel, t.level)
      b.invested += t.invested
    }
    return out
  }

  /**
   * Plays a saved record back into this engine, so a run lost to a closed tab,
   * a phone call or a reload carries on from where it was.
   *
   * The engine is deterministic, so the record alone is the whole game: the
   * same seed and the same actions at the same ticks rebuild the same board,
   * enemy for enemy. It is the server's replay, run in the browser, except that
   * the actions go through the engine's own methods and so are recorded again,
   * and the record carries on growing as if nothing happened. The holder bonus
   * and revives come back with it, as the deltas they were.
   *
   * Silent while it runs, and in slices so the page can show progress: a wave
   * 45 run is about 200,000 ticks.
   */
  async fastForward(record: RunRecord, onProgress?: (done: number) => void): Promise<void> {
    const byTick = new Map<number, RunAction[]>()
    for (const a of record.actions) {
      const list = byTick.get(a.tick)
      if (list) list.push(a)
      else byTick.set(a.tick, [a])
    }
    const apply = (a: RunAction) => {
      switch (a.type) {
        case 'place':
          if (a.kind !== undefined && a.x !== undefined && a.y !== undefined) this.placeAt(a.kind, { x: a.x, y: a.y })
          break
        case 'upgrade':
          if (a.x !== undefined && a.y !== undefined) this.upgradeAt(key({ x: a.x, y: a.y }))
          break
        case 'sell':
          if (a.x !== undefined && a.y !== undefined) this.sellAt(key({ x: a.x, y: a.y }))
          break
        case 'target':
          if (a.x !== undefined && a.y !== undefined && a.target) this.setTargetAt(key({ x: a.x, y: a.y }), a.target)
          break
        case 'wave':
          this.callNextWave()
          break
        case 'revive':
          this.revive(a.tx)
          break
        case 'bonus':
          this.grantBonus(this.bonusTotal + Math.max(0, Math.floor(a.amount ?? 0)))
          break
      }
    }
    const total = Math.max(0, Math.floor(record.ticks))
    const SLICE = 4000
    sfx.hold = true
    try {
      // Unlike the server's replay this also applies what landed on the very
      // last tick: a tower placed a moment before the tab closed is part of
      // the run the player left.
      for (let tick = 0; tick <= total; tick++) {
        for (const a of byTick.get(tick) ?? []) apply(a)
        if (tick === total || this.over) break
        this.simulate(TICK)
        this.tickCount += 1
        if (tick % SLICE === SLICE - 1) {
          this.fx.length = 0
          onProgress?.(tick / total)
          await new Promise((r) => setTimeout(r, 0))
        }
      }
    } finally {
      sfx.hold = false
    }
    // Banners, coin floats and puffs from an hour of play, all at once, are
    // not something to show anybody.
    this.fx.length = 0
    this.selectedCell = null
    this.state.selected = null
    this.state.palette = null
    onProgress?.(1)
    this.emit()
  }

  /**
   * The board as it stands, drawn clean: no effects, no selection. For the
   * share card. A run ends on a leak, and the red flash of that last leak is
   * still on the live canvas, frozen, because nothing ages it once the run is
   * over; nobody sees it behind the end screen, but a copy of it would.
   */
  snapshot(): HTMLCanvasElement | null {
    if (!this.canvas) return null
    const fx = this.fx
    const selected = this.selectedCell
    const ghost = this.ghostCell
    this.fx = []
    this.selectedCell = null
    this.ghostCell = null
    this.render()
    const out = document.createElement('canvas')
    out.width = this.canvas.width
    out.height = this.canvas.height
    out.getContext('2d')?.drawImage(this.canvas, 0, 0)
    this.fx = fx
    this.selectedCell = selected
    this.ghostCell = ghost
    return out
  }

  /** The run, as something the server can re-simulate and check. */
  record(): RunRecord {
    return {
      version: RECORD_VERSION,
      seed: this.seed.toString(),
      mode: this.mode.kind === 'level' ? 'level' : 'endless',
      levelId: this.mode.kind === 'level' ? this.mode.id : null,
      ticks: this.tickCount,
      actions: this.actions,
    }
  }

  private emit() {
    this.state = {
      ...this.state,
      interlude: Math.max(0, this.interludeRemaining),
      callBonus: this.canCallEarly() ? this.earlyBonus() : null,
    }
    this.onState(this.state)
  }

  // MARK: - Public controls

  setPalette(kind: TowerKind | null) {
    this.state.palette = kind
    if (kind) this.deselect()
    this.emit()
  }

  setSpeed(s: number) {
    this.state.speed = s
    this.emit()
  }

  callNextWave() {
    if (this.over) return
    if (this.fighting && !this.canCallEarly()) return
    if (!this.headless) this.actions.push({ tick: this.tickCount, type: 'wave' })
    if (this.fighting) {
      // The wave on the field will never reach endWave as itself: its
      // completion bonus is paid now, with the bonus for the risk on top.
      const done = completionBonus(this.state.wave, this.mode.kind === 'endless')
      const early = this.earlyBonus()
      this.state.gold += done + early
      this.float(`+${done}`, C.width / 2, C.height * 0.45, '#ffd94d')
      if (early > 0) this.float(`+${early} EARLY`, C.width / 2, C.height * 0.4, '#ffd94d')
    } else if (this.state.autoWave && this.interludeRemaining > 0) {
      const bonus = Math.floor(this.interludeRemaining) * 2
      if (bonus > 0) {
        this.state.gold += bonus
        this.float(`+${bonus}`, C.width / 2, C.height * 0.4, '#ffd94d')
      }
    }
    this.startWave()
  }

  /**
   * The next wave may come while this one is still walking, once all of it is
   * out and nothing older is left: two waves on the field at most. Never past
   * the last wave of a level, which has to end the way it always did.
   */
  canCallEarly(): boolean {
    if (this.over || !this.fighting || this.spawnQueue.length) return false
    if (this.state.waveTarget && this.state.wave >= this.state.waveTarget) return false
    return this.enemies.every((e) => e.wave === this.state.wave)
  }

  /**
   * The reward for calling a wave early: a share of its completion bonus, as
   * large as the share of the wave still standing. Called the moment the last
   * one is out it is nearly the whole share; with one straggler left, little.
   */
  private earlyBonus(): number {
    let hp = 0
    let max = 0
    for (const e of this.enemies) {
      if (e.wave !== this.state.wave) continue
      hp += Math.max(0, e.hp)
      max += e.maxHP
    }
    if (max <= 0) return 0
    return Math.round(completionBonus(this.state.wave, this.mode.kind === 'endless') * EARLY_CALL_SHARE * (hp / max))
  }

  private get maxLevel() {
    return maxTowerLevel(this.mode.kind === 'endless')
  }

  upgradeSelected() {
    this.upgradeAt(this.selectedCell)
  }

  sellSelected() {
    this.sellAt(this.selectedCell)
  }

  /** Same code the UI drives, addressed by cell so a replay can drive it too. */
  upgradeAt(cellKey: string | null) {
    const t = cellKey ? this.towers.get(cellKey) : null
    if (!t || t.level >= this.maxLevel) return
    const cost = upgradeCost(t.kind, t.level + 1)
    if (this.state.gold < cost) return
    if (!this.headless) this.actions.push({ tick: this.tickCount, type: 'upgrade', x: t.cell.x, y: t.cell.y })
    this.state.gold -= cost
    t.level += 1
    t.invested += cost
    t.pop = 0.2
    this.state.upgradesDone += 1
    sfx.play('upgrade')
    this.fx.push({ t: 0, type: 'ring', dur: 0.4, x: t.x, y: t.y, radius: 40, color: '#ffe566' })
    this.publishSelection()
    this.emit()
  }

  sellAt(cellKey: string | null) {
    const t = cellKey ? this.towers.get(cellKey) : null
    if (!t) return
    if (!this.headless) this.actions.push({ tick: this.tickCount, type: 'sell', x: t.cell.x, y: t.cell.y })
    this.state.gold += this.sellValue(t)
    this.float(`+${this.sellValue(t)}`, t.x, t.y, '#ffd94d')
    this.towers.delete(cellKey!)
    sfx.play('sell')
    if (cellKey === this.selectedCell) this.deselect()
    this.emit()
  }

  setSelectedTarget(mode: TargetMode) {
    this.setTargetAt(this.selectedCell, mode)
  }

  /**
   * Points a tower at a kind of enemy. A recorded action like any other: it
   * changes who dies when, so the replay has to make the same choice at the
   * same tick.
   */
  setTargetAt(cellKey: string | null, mode: TargetMode): boolean {
    const t = cellKey ? this.towers.get(cellKey) : null
    if (!t || !aims(t.kind) || !TARGET_MODES.includes(mode) || t.target === mode) return false
    if (!this.headless) this.actions.push({ tick: this.tickCount, type: 'target', x: t.cell.x, y: t.cell.y, target: mode })
    t.target = mode
    this.lastTarget[t.kind] = mode
    sfx.play('tap')
    this.publishSelection()
    this.emit()
    return true
  }

  deselect() {
    this.selectedCell = null
    this.state.selected = null
    this.emit()
  }

  private sellValue = (t: Tower) => Math.floor(t.invested * C.sellRefund)

  // MARK: - Terrain

  private buildTerrain() {
    const px = 2
    const cv = document.createElement('canvas')
    cv.width = C.width * px
    cv.height = C.height * px
    const g = cv.getContext('2d')!
    g.scale(px, px)
    for (let y = 0; y < this.map.rows; y++) {
      for (let x = 0; x < this.map.cols; x++) {
        const p = { x, y }
        const c = center(p)
        let tile: HTMLCanvasElement
        if (this.map.pathSet.has(key(p))) {
          let edges = 0
          if (!this.map.pathSet.has(key({ x, y: y - 1 }))) edges |= EDGE.top
          if (!this.map.pathSet.has(key({ x, y: y + 1 }))) edges |= EDGE.bottom
          if (!this.map.pathSet.has(key({ x: x - 1, y }))) edges |= EDGE.left
          if (!this.map.pathSet.has(key({ x: x + 1, y }))) edges |= EDGE.right
          tile = pathTile(edges)
        } else {
          tile = grassTile((x * 31 + y * 17 + (x ^ y)) % 4)
        }
        g.drawImage(tile, c.x - C.cell / 2, c.y - C.cell / 2, C.cell, C.cell)
      }
    }
    // spawn portal sits flat on the ground
    const portal = img('gate_portal')
    const first = this.waypoints[0]
    if (portal && first) {
      const side = C.cell * 1.1
      const k = side / Math.max(portal.width, portal.height)
      const w = portal.width * k
      const h = portal.height * k
      g.drawImage(portal, first.x - w / 2, first.y - h / 2, w, h)
    }
    this.terrain = cv
  }

  // MARK: - Waves

  private startWave() {
    this.state.wave += 1
    this.recordBest()
    const plan = wavePlan(this.state.wave, this.mode.kind === 'endless')
    if (this.mode.kind === 'level') {
      plan.baseHP *= hpMult(this.mode.id)
      plan.goldPerKill *= goldMult(this.mode.id)
    }
    this.plan = plan
    const queue: EnemyKind[] = []
    for (const e of plan.entries) for (let i = 0; i < e.count; i++) queue.push(e.kind)
    if (!plan.isBossWave) this.rng.shuffle(queue)
    this.spawnQueue = queue
    this.spawnTimer = 0
    this.fighting = true
    this.state.phase = 'fighting'
    sfx.play('wave')
    this.fx.push({
      t: 0,
      type: 'banner',
      dur: 1.9,
      text: plan.isBossWave ? `BOSS ${this.state.wave}` : `${this.state.wave}`,
      // The counter to a boss is not obvious: splash towers that clear a crowd
      // barely scratch one huge target. Said once per boss wave, where it matters.
      sub: plan.isBossWave ? 'AIM LANCE & BALLISTA AT THE STRONGEST' : undefined,
      color: plan.isBossWave ? '#f24d4d' : '#ffffff',
    })
    this.emit()
  }

  private endWave() {
    this.fighting = false
    if (this.state.waveTarget && this.state.wave >= this.state.waveTarget) {
      this.triggerVictory()
      return
    }
    const bonus = completionBonus(this.state.wave, this.mode.kind === 'endless')
    this.state.gold += bonus
    this.float(`+${bonus}`, C.width / 2, C.height * 0.45, '#ffd94d')
    this.interludeRemaining = C.interlude
    this.state.phase = 'interlude'
    this.emit()
  }

  private spawnEnemy(kind: EnemyKind) {
    if (!this.plan) return
    const first = this.waypoints[0]
    const def = enemyDef(kind, this.mode.kind === 'endless')
    const hp = this.plan.baseHP * def.hpMult
    const frames = walkFrames(kind)
    const height = frames || character(kind) ? def.radius * 3.0 : def.radius * 2.2
    this.enemies.push({
      kind,
      x: first.x,
      y: first.y,
      hp,
      maxHP: hp,
      armor: def.armorMult > 0 ? armorFor(this.state.wave) * def.armorMult : 0,
      gold: Math.max(1, Math.round(this.plan.goldPerKill * def.goldMult)),
      nextWaypoint: 1,
      progress: 0,
      slow: 1,
      burn: 0,
      shred: 0,
      animT: Math.random(), // cosmetic: walk-cycle phase
      spawnT: 0,
      faceRight: false,
      damaged: false,
      height,
      wave: this.state.wave,
    })
  }

  // MARK: - Simulation

  private simulate(dt: number) {
    this.clock += dt
    if (this.fighting) {
      if (this.spawnQueue.length) {
        this.spawnTimer -= dt
        if (this.spawnTimer <= 0) {
          this.spawnEnemy(this.spawnQueue.shift()!)
          this.spawnTimer = this.plan?.spawnInterval ?? 0.8
        }
      }
      if (!this.spawnQueue.length && !this.enemies.length) this.endWave()
    } else if (this.state.autoWave && !this.over) {
      this.interludeRemaining -= dt
      if (this.interludeRemaining <= 0) this.startWave()
    }

    this.moveEnemies(dt)
    this.updateTowers(dt)
    this.updateProjectiles(dt)

    for (const t of this.towers.values()) if (t.pop > 0) t.pop = Math.max(0, t.pop - dt)
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i] as FX & { t: number }
      f.t += dt
      if (f.t >= f.dur) this.fx.splice(i, 1)
    }
  }

  private moveEnemies(dt: number) {
    for (const e of this.enemies) {
      e.slow = 1
      if (e.burn > 0) e.burn = Math.max(0, e.burn - dt)
      if (e.shred > 0) e.shred = Math.max(0, e.shred - dt)
    }
    for (const t of this.towers.values()) {
      if (t.kind !== 'frost') continue
      const s = towerStats(t.kind, t.level)
      for (const e of this.enemies) {
        if (dist(e.x - t.x, e.y - t.y) <= s.range) e.slow = Math.min(e.slow, s.slowFactor)
      }
    }

    const leaked: Enemy[] = []
    for (const e of this.enemies) {
      e.spawnT = Math.min(1, e.spawnT + dt / 0.35)
      e.animT += dt
      if (e.nextWaypoint >= this.waypoints.length) {
        leaked.push(e)
        continue
      }
      const target = this.waypoints[e.nextWaypoint]
      const dx = target.x - e.x
      const dy = target.y - e.y
      const d = dist(dx, dy)
      const step = ENEMY[e.kind].speed * dt * e.slow
      if (d <= step) {
        e.x = target.x
        e.y = target.y
        e.nextWaypoint += 1
        if (e.nextWaypoint >= this.waypoints.length) leaked.push(e)
      } else {
        e.x += (dx / d) * step
        e.y += (dy / d) * step
      }
      if (Math.abs(dx) > 0.5) e.faceRight = dx > 0
      e.progress += step
    }

    for (const e of leaked) {
      this.removeEnemy(e)
      const cost = enemyDef(e.kind, this.mode.kind === 'endless').livesCost
      const leak = (this.stats.leaks[e.kind] ??= { count: 0, lives: 0 })
      leak.count += 1
      leak.lives += Math.min(cost, this.state.lives)
      this.state.lives = Math.max(0, this.state.lives - cost)
      sfx.play('leak')
      this.fx.push({ t: 0, type: 'leak', dur: 0.35 })
      if (this.state.lives <= 0) this.triggerGameOver()
    }
    if (leaked.length) this.emit()
  }

  private inRange(e: Enemy, t: Tower, s: TowerStats) {
    const d = dist(e.x - t.x, e.y - t.y)
    // minRange is 0 for everything but the mortar, which cannot depress its
    // barrel far enough to defend the ground it is standing on.
    return d <= s.range + ENEMY[e.kind].radius && d >= s.minRange
  }

  /**
   * The strongest beacon covering this tower, as a damage multiplier.
   *
   * Strongest rather than the product of all of them, on purpose. If beacons
   * stacked, a wall of them would be the only build worth making and the
   * interesting question would disappear. The decision this tower exists to
   * create is *where* one goes, not how many.
   */
  private buffAt(t: Tower): number {
    let best = 1
    for (const b of this.towers.values()) {
      if (b === t || b.kind !== 'beacon') continue
      const s = towerStats('beacon', b.level)
      if (dist(b.x - t.x, b.y - t.y) <= s.range && s.buff > best) best = s.buff
    }
    return best
  }

  /**
   * The enemy in range this tower's target mode ranks highest. Every mode
   * breaks ties by progress, and `first` is nothing but progress, which is
   * exactly what every tower did before there was a choice.
   */
  private pickTarget(t: Tower, s: TowerStats): Enemy | null {
    let best: Enemy | null = null
    let bestRank = -Infinity
    for (const e of this.enemies) {
      if (e.hp <= 0 || !this.inRange(e, t, s)) continue
      const rank = t.target === 'strong' ? e.maxHP : t.target === 'armored' ? (e.armor > 0 ? 1 : 0) : 0
      if (!best || rank > bestRank || (rank === bestRank && e.progress > best.progress)) {
        best = e
        bestRank = rank
      }
    }
    return best
  }

  private muzzle(t: Tower) {
    return { x: t.x, y: t.y - C.cell * 0.62 }
  }

  private updateTowers(dt: number) {
    for (const t of this.towers.values()) {
      t.cooldown -= dt
      const base = towerStats(t.kind, t.level)
      // A beacon never fires and never picks a target. Its whole contribution is
      // read by the towers around it, in buffAt().
      if (t.kind === 'beacon') continue
      if (t.kind === 'frost') {
        if (t.cooldown <= 0 && this.enemies.some((e) => this.inRange(e, t, base))) {
          t.cooldown = 1.6
          this.fx.push({ t: 0, type: 'frost', dur: 0.6, x: t.x, y: t.y, range: base.range })
        }
        continue
      }
      // Frost is above this line because a multiplier on zero damage is zero.
      const boost = this.buffAt(t) * (this.state.wave === this.rallyWave ? REVIVE_RALLY : 1)
      const s = boost === 1 ? base : { ...base, damage: base.damage * boost }
      const target = this.pickTarget(t, s)
      if (!target) continue
      if (t.kind === 'flame') {
        if (t.cooldown <= 0) {
          t.cooldown = s.fireInterval
          // A copy, because a burning enemy that dies here explodes, and the
          // explosion can take others off the list mid-loop.
          for (const e of [...this.enemies]) {
            if (e.hp <= 0 || !this.inRange(e, t, s)) continue
            e.burn = COMBO.burnTime
            this.damage(e, s.damage, false, 'flame')
          }
          this.flameBreath(t, target, s)
        }
      } else if (t.kind === 'tesla') {
        if (t.cooldown <= 0) {
          t.cooldown = s.fireInterval
          this.fireTesla(t, target, s)
        }
      } else if (t.cooldown <= 0) {
        t.cooldown = s.fireInterval
        this.fireProjectile(t, target, s)
      }
    }
  }

  private fireProjectile(t: Tower, target: Enemy, s: TowerStats) {
    const mortar = t.kind === 'mortar'
    const cannon = t.kind === 'cannon' || mortar
    const m = this.muzzle(t)
    this.projectiles.push({
      x: m.x,
      y: m.y,
      tx: target.x,
      ty: target.y,
      target,
      // A mortar shell is slower than a cannon ball and travels a lot further,
      // so the delay before it lands is part of what you are paying for.
      speed: mortar ? 360 : cannon ? 460 : 820,
      damage: s.damage,
      splash: s.splash,
      cannon,
      pierce: s.pierce,
      angle: 0,
      by: t.kind,
    })
    sfx.play(cannon ? 'cannon' : 'shoot')
    if (cannon) this.fx.push({ t: 0, type: 'muzzle', dur: 0.12, x: m.x, y: m.y })
  }

  private updateProjectiles(dt: number) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i]
      if (p.target && p.target.hp > 0) {
        p.tx = p.target.x
        p.ty = p.target.y
      }
      const dx = p.tx - p.x
      const dy = p.ty - p.y
      const d = dist(dx, dy)
      const step = p.speed * dt
      p.angle = Math.atan2(dy, dx)
      if (d <= step) {
        p.x = p.tx
        p.y = p.ty
        this.impact(p)
        this.projectiles.splice(i, 1)
      } else {
        p.x += (dx / d) * step
        p.y += (dy / d) * step
      }
    }
  }

  private impact(p: Projectile) {
    if (p.splash > 0) {
      this.explosion(p.x, p.y, p.splash)
      // A copy: a kill takes an enemy off the list, and a burning one going up
      // can take several, which would make the loop skip the next in line.
      for (const e of [...this.enemies]) {
        if (e.hp <= 0) continue
        const reach = p.splash + ENEMY[e.kind].radius
        const d = dist(e.x - p.x, e.y - p.y)
        if (d <= reach) {
          const falloff = Math.max(0.4, 1 - (d / reach) * 0.5)
          this.damage(e, p.damage * falloff, p.pierce, p.by)
          // The shell cracks the armour of whatever it did not kill.
          if (p.by === 'mortar' && e.hp > 0) e.shred = COMBO.shredTime
        }
      }
    } else if (p.target && p.target.hp > 0) {
      this.damage(p.target, p.damage, p.pierce, p.by)
      this.fx.push({ t: 0, type: 'spark', dur: 0.15, x: p.x, y: p.y })
    }
  }

  private fireTesla(t: Tower, first: Enemy, s: TowerStats) {
    const chain: Enemy[] = [first]
    let last = first
    while (chain.length < s.chain) {
      let next: Enemy | null = null
      let bestD = Infinity
      for (const e of this.enemies) {
        if (e.hp <= 0 || chain.includes(e)) continue
        const d = dist(e.x - last.x, e.y - last.y)
        if (d <= 130 && d < bestD) {
          bestD = d
          next = e
        }
      }
      if (!next) break
      chain.push(next)
      last = next
    }
    const m = this.muzzle(t)
    const nodes = [m, ...chain.map((e) => ({ x: e.x, y: e.y }))]
    const pts: { x: number; y: number }[] = [nodes[0]]
    for (let i = 1; i < nodes.length; i++) {
      const from = nodes[i - 1]
      const to = nodes[i]
      for (let seg = 1; seg <= 4; seg++) {
        const k = seg / 4
        const jitter = seg < 4 ? 8 : 0
        pts.push({
          x: from.x + (to.x - from.x) * k + rand(-jitter, jitter),
          y: from.y + (to.y - from.y) * k + rand(-jitter, jitter),
        })
      }
    }
    this.fx.push({ t: 0, type: 'bolt', dur: 0.18, pts })
    sfx.play('zap')
    let dmg = s.damage
    for (const e of chain) {
      // Read before the hit: `slow` is set at the start of the tick and the
      // first enemy dying does not unfreeze the second.
      this.damage(e, e.slow < 1 ? dmg * COMBO.teslaChill : dmg, false, 'tesla')
      dmg *= 0.72
    }
  }

  private flameBreath(t: Tower, e: Enemy, s: TowerStats) {
    const m = this.muzzle(t)
    const dir = Math.atan2(e.y - t.y, e.x - t.x)
    const spread = rand(-0.25, 0.25)
    const reach = Math.min(s.range, dist(e.x - t.x, e.y - t.y))
    this.fx.push({
      t: 0,
      type: 'flame',
      dur: 0.28,
      x: m.x + Math.cos(dir) * 14,
      y: m.y + Math.sin(dir) * 14,
      dx: Math.cos(dir + spread) * reach,
      dy: Math.sin(dir + spread) * reach,
      hue: rand(0.4, 0.7),
    })
  }

  private explosion(x: number, y: number, radius: number) {
    const parts = Array.from({ length: 6 }, () => ({
      a: rand(0, Math.PI * 2),
      d: rand(20, radius),
      s: rand(0.4, 0.8),
    }))
    this.fx.push({ t: 0, type: 'boom', dur: 0.3, x, y, radius, parts })
    sfx.play('boom')
  }

  /**
   * `pierce` is the lance and nothing else: it ignores armour outright.
   *
   * Armour comes off every hit rather than off the total, which is what makes it
   * a counter to rate of fire instead of a flat tax. A flame tick loses almost
   * all of itself, a mortar shell barely notices.
   *
   * The floor matters more than it looks. Letting armour reduce a hit to zero
   * means a board of nothing but flame can never finish an armoured wave, and
   * the run hangs rather than ends. A tenth of the damage still gets through,
   * so that board loses on its own terms instead of freezing.
   */
  private damage(e: Enemy, amount: number, pierce = false, by?: TowerKind) {
    if (e.hp <= 0) return
    // A mortar shell cracked it: for a few seconds every hit is a lance hit.
    const armor = e.shred > 0 ? 0 : e.armor
    const dealt = pierce || armor <= 0 ? amount : Math.max(amount * 0.1, amount - armor)
    const tally = by ? (this.stats.byTower[by] ??= { damage: 0, kills: 0 }) : null
    if (tally) tally.damage += Math.min(dealt, e.hp)
    e.hp -= dealt
    e.damaged = true
    if (e.hp <= 0) {
      if (tally) tally.kills += 1
      this.stats.goldEarned += e.gold
      this.state.gold += e.gold
      this.state.kills += 1
      sfx.play('coin')
      this.float(`+${e.gold}`, e.x, e.y, '#ffd94d', true)
      this.fx.push({
        t: 0,
        type: 'puff',
        dur: 0.35,
        x: e.x,
        y: e.y,
        parts: Array.from({ length: 5 }, () => ({
          a: rand(0, Math.PI * 2),
          d: rand(8, 22),
          s: rand(0.5, 1),
        })),
      })
      this.removeEnemy(e)
      if (e.burn > 0) this.burst(e)
    }
  }

  /**
   * A burning enemy going up. Burns the ones around it, which may be burning
   * too, so a crowd in a flame tower's reach can go off in a chain. That is the
   * point; it ends because every link costs an enemy, and the dead are off the
   * list before their own blast goes out.
   */
  private burst(from: Enemy) {
    const amount = from.maxHP * COMBO.burstShare
    this.fx.push({ t: 0, type: 'ring', dur: 0.35, x: from.x, y: from.y, radius: COMBO.burstRadius, color: '#ff8a2b' })
    for (const e of [...this.enemies]) {
      if (e.hp <= 0) continue
      if (dist(e.x - from.x, e.y - from.y) <= COMBO.burstRadius + ENEMY[e.kind].radius) this.damage(e, amount, false, 'flame')
    }
  }

  private removeEnemy(e: Enemy) {
    const i = this.enemies.indexOf(e)
    if (i >= 0) this.enemies.splice(i, 1)
  }

  private float(text: string, x: number, y: number, color: string, small = false) {
    this.fx.push({
      t: 0,
      type: 'float',
      dur: 1.05,
      text,
      color,
      x,
      y,
      small,
      drift: rand(-12, 12),
    })
  }

  private recordBest() {
    if (this.mode.kind !== 'endless') return
    if (this.state.wave > this.state.bestWave) {
      this.state.bestWave = this.state.wave
      Progress.bestWave = this.state.wave
    }
  }

  private triggerVictory() {
    if (this.over) return
    this.over = true
    if (this.mode.kind === 'level') {
      this.state.victoryStars = Progress.recordWin(this.mode.id, this.state.lives)
    }
    this.state.phase = 'victory'
    sfx.play('victory')
    this.emit()
    this.onEnd(this.state)
  }

  /**
   * Brings a fallen Endless run back, paid for by burning tokens.
   *
   * The field is cleared and the lives restored, then the run gets an interlude
   * and the wave that broke the wall is fought again: "continue where you
   * fell", not a free skip past it. Endless only, and never in the Siege or on
   * the daily map, where a paid second life would be paid-for advantage. The
   * replay applies this only as many times as the server found valid burns.
   */
  revive(tx?: string): boolean {
    if (!this.over || this.state.phase !== 'gameOver' || this.mode.kind !== 'endless') return false
    this.enemies = []
    this.projectiles = []
    this.spawnQueue = []
    this.plan = null
    this.fighting = false
    this.over = false
    this.state.wave = Math.max(0, this.state.wave - 1)
    this.state.lives = C.startLives
    this.state.revives += 1
    // The wave about to be fought again is fought rallied.
    this.rallyWave = this.state.wave + 1
    this.interludeRemaining = C.interlude
    this.state.phase = 'interlude'
    if (!this.headless) this.actions.push({ tick: this.tickCount, type: 'revive', tx })
    this.fx.push({ t: 0, type: 'banner', dur: 2.2, text: 'REVIVED · TOWERS +30%', color: '#7fd4ff' })
    this.emit()
    return true
  }

  private triggerGameOver() {
    if (this.over) return
    this.over = true
    this.fighting = false
    this.recordBest()
    this.state.phase = 'gameOver'
    sfx.play('gameover')
    this.emit()
    this.onEnd(this.state)
  }

  // MARK: - Input

  private onDown = (ev: PointerEvent) => {
    this.pointerInside = true
    if (ev.button !== 0) return
    if (this.state.palette) this.ghostCell = this.cellAt(ev)
  }

  private onMove = (ev: PointerEvent) => {
    this.pointerInside = true
    if (this.state.palette) this.ghostCell = this.cellAt(ev)
  }

  private onLeave = () => {
    this.pointerInside = false
    this.ghostCell = null
  }

  private onUp = (ev: PointerEvent) => {
    if (this.over) return
    // Only the main button builds. A right click put a tower down too, where
    // every player expects it to let go of what they are holding.
    if (ev.button !== 0) {
      this.ghostCell = null
      if (this.state.palette) {
        this.state.palette = null
        this.emit()
      }
      this.deselect()
      return
    }
    const cell = this.cellAt(ev)
    this.ghostCell = null
    const kind = this.state.palette
    if (kind && this.canPlace(kind, cell)) {
      this.place(kind, cell)
      if (this.state.gold < TOWER_COST[kind]) this.state.palette = null
      this.emit()
      return
    }
    if (this.towers.has(key(cell))) {
      this.selectedCell = key(cell)
      this.state.palette = null
      sfx.play('tap')
      this.publishSelection()
      this.emit()
    } else {
      this.deselect()
    }
  }

  private bindInput() {
    if (!this.canvas) return
    this.canvas.addEventListener('pointerdown', this.onDown)
    this.canvas.addEventListener('pointermove', this.onMove)
    this.canvas.addEventListener('pointerup', this.onUp)
    this.canvas.addEventListener('pointerleave', this.onLeave)
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
  }

  /** The right button cancels (in onUp); the browser's menu would only get in the way. */
  private onContextMenu = (ev: Event) => ev.preventDefault()

  private unbindInput() {
    if (!this.canvas) return
    this.canvas.removeEventListener('pointerdown', this.onDown)
    this.canvas.removeEventListener('pointermove', this.onMove)
    this.canvas.removeEventListener('pointerup', this.onUp)
    this.canvas.removeEventListener('pointerleave', this.onLeave)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
  }

  private cellAt(ev: PointerEvent): GridPoint {
    const r = this.canvas!.getBoundingClientRect()
    const x = ((ev.clientX - r.left) / r.width) * C.width
    const y = ((ev.clientY - r.top) / r.height) * C.height
    return { x: Math.floor(x / C.cell), y: Math.floor(y / C.cell) }
  }

  private canPlace(kind: TowerKind, cell: GridPoint) {
    return (
      isBuildable(this.map, cell) &&
      !this.towers.has(key(cell)) &&
      this.state.gold >= TOWER_COST[kind]
    )
  }

  private place(kind: TowerKind, cell: GridPoint) {
    const c = center(cell)
    this.towers.set(key(cell), {
      kind,
      level: 1,
      cell,
      x: c.x,
      y: c.y,
      cooldown: 0,
      invested: TOWER_COST[kind],
      pop: 0.2,
      target: this.lastTarget[kind] ?? 'first',
    })
    if (!this.headless) this.actions.push({ tick: this.tickCount, type: 'place', x: cell.x, y: cell.y, kind })
    this.state.gold -= TOWER_COST[kind]
    this.state.towersBuilt += 1
    sfx.play('place')
  }

  private publishSelection() {
    const t = this.selectedCell ? this.towers.get(this.selectedCell) : null
    if (!t) return
    // What a beacon is doing for this tower right now, so the number on screen
    // is the one it actually fires with rather than the one on the price tag.
    const boost = t.kind === 'beacon' || t.kind === 'frost' ? 1 : this.buffAt(t)
    const { statKey, statArgs } = towerReadout(t.kind, t.level, boost)
    this.state.selected = {
      kind: t.kind,
      level: t.level,
      upgradeCost: t.level < this.maxLevel ? upgradeCost(t.kind, t.level + 1) : null,
      sellValue: this.sellValue(t),
      statKey,
      statArgs,
      target: aims(t.kind) ? t.target : null,
    }
  }

  // MARK: - Render

  resize() {
    if (!this.canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const r = this.canvas.getBoundingClientRect()
    if (!r.width) return
    this.canvas.width = Math.round(r.width * dpr)
    this.canvas.height = Math.round(r.height * dpr)
    this.scale = this.canvas.width / C.width
  }

  private render() {
    const g = this.g
    if (!g || !this.canvas) return
    if (this.canvas.width === 0) this.resize()
    g.save()
    // Clear in device pixels: the scene is 640x960 scaled by width alone, so a
    // canvas even a rounding error taller would keep stale pixels along the
    // bottom edge if we only cleared the scene rect.
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, this.canvas.width, this.canvas.height)
    g.setTransform(this.scale, 0, 0, this.scale, 0, 0)
    if (this.terrain) g.drawImage(this.terrain, 0, 0, C.width, C.height)

    // depth-sorted world layer
    type Drawable = { y: number; draw: () => void }
    const list: Drawable[] = []

    for (const [k, kind] of this.map.decor) {
      const [cx, cy] = k.split(',').map(Number)
      const c = center({ x: cx, y: cy })
      const name = kind === 0 ? 'nat_rock' : kind === 1 ? ((cx + cy) % 2 === 0 ? 'nat_pine' : 'nat_tree') : 'nat_bush'
      const im = img(name)
      if (!im) continue
      const tall = kind === 1
      const h = C.cell * (tall ? 1.35 : 0.72)
      const w = (im.width / im.height) * h
      const y = c.y + C.cell * 0.3
      list.push({
        y,
        draw: () => {
          softEllipse(g, c.x, y, w * 0.8, w * 0.26, '#000', 0.22)
          drawAnchored(g, im, c.x, y, w, h, 0.5, tall ? 0.12 : 0.2)
        },
      })
    }

    const castle = img('gate_castle')
    const last = this.waypoints[this.waypoints.length - 1]
    if (castle && last) {
      const w = C.cell * 1.3
      const h = (castle.height / castle.width) * w
      const y = last.y + C.cell * 0.25
      list.push({
        y,
        draw: () => {
          softEllipse(g, last.x, y, w * 0.9, w * 0.26, '#000', 0.24)
          drawAnchored(g, castle, last.x, y, w, h, 0.5, 0.18)
        },
      })
    }

    for (const t of this.towers.values()) {
      const im = building(t.kind, t.level)
      if (!im) continue
      const pop = t.pop > 0 ? 1 + Math.sin((1 - t.pop / 0.2) * Math.PI) * 0.12 : 1
      // towerDrawScale keeps the stone base the same size across every kind,
      // whatever its weapon hangs over the edge.
      const w = C.cell * (0.92 + (t.level - 1) * 0.05) * pop * towerDrawScale(t.kind)
      const h = (im.height / im.width) * w
      const over = t.level - 3
      list.push({
        y: t.y,
        draw: () => {
          softEllipse(g, t.x, t.y + C.cell * 0.27, C.cell * 0.86, C.cell * 0.3, '#000', 0.26)
          // Overcharged towers reuse the level-3 model, so the tier has to read
          // from the glow and the chevrons instead.
          if (over > 0) {
            const pulse = 0.5 + 0.5 * Math.sin(this.clock * 2.6 + t.x * 0.05)
            softEllipse(
              g,
              t.x,
              t.y + C.cell * 0.24,
              C.cell * (0.98 + 0.12 * pulse),
              C.cell * 0.44,
              over > 1 ? '#ff7a3d' : '#ffcf4d',
              0.3 + 0.22 * pulse,
            )
          }
          // Anchored by the foot of the tower, not by a fraction of its height.
          //
          // The old 0.16-of-height anchor sank a tall sprite deeper into the
          // tile than a short one, which never showed while every tower was
          // about as tall as the next. A lance carries its harpoon a long way
          // up and a mortar its barrel, so those two sat visibly lower in the
          // ground than the keep beside them. Pinning the base instead puts
          // every tower on one line whatever it is holding, and closes the
          // 4.5px drift the original five had between ballista and tesla.
          drawAnchored(g, im, t.x, t.y + C.cell * 0.5, w, h, 0.5, 0)
          for (let i = 0; i < over; i++) {
            const cx = t.x + (i - (over - 1) / 2) * 11
            const cy = t.y - C.cell * 0.66
            g.save()
            g.fillStyle = over > 1 ? '#ff9a4d' : '#ffdf7a'
            g.strokeStyle = 'rgba(0,0,0,0.6)'
            g.lineWidth = 2
            g.beginPath()
            g.moveTo(cx, cy - 5)
            g.lineTo(cx + 5, cy + 2)
            g.lineTo(cx, cy)
            g.lineTo(cx - 5, cy + 2)
            g.closePath()
            g.stroke()
            g.fill()
            g.restore()
          }
        },
      })
    }

    for (const e of this.enemies) {
      list.push({ y: e.y, draw: () => this.drawEnemy(g, e) })
    }

    list.sort((a, b) => a.y - b.y)
    for (const d of list) d.draw()

    // projectiles
    for (const p of this.projectiles) {
      g.save()
      g.translate(p.x, p.y)
      g.rotate(p.angle)
      if (p.cannon) {
        g.fillStyle = '#3b3f4a'
        g.beginPath()
        g.arc(0, 0, 7, 0, Math.PI * 2)
        g.fill()
        g.fillStyle = 'rgba(255,255,255,0.35)'
        g.beginPath()
        g.arc(-2, -2, 2.4, 0, Math.PI * 2)
        g.fill()
      } else {
        g.fillStyle = '#f0d9a8'
        g.fillRect(-11, -1.8, 22, 3.6)
        g.fillStyle = '#2b2e3a'
        g.beginPath()
        g.moveTo(11, 0)
        g.lineTo(4, -4)
        g.lineTo(4, 4)
        g.closePath()
        g.fill()
      }
      g.restore()
    }

    this.drawEffects(g)
    this.drawInteraction(g)
    g.restore()
  }

  private drawEnemy(g: CanvasRenderingContext2D, e: Enemy) {
    const def = ENEMY[e.kind]
    const frames = walkFrames(e.kind)
    const im = frames ? frames[Math.floor(e.animT / this.frameTime(e)) % frames.length] : character(e.kind)
    const h = e.height
    const bob = frames ? Math.sin(e.animT / this.frameTime(e) * Math.PI) * 1.2 : 0
    softEllipse(g, e.x, e.y + h * 0.46, def.radius * 1.9, def.radius * 0.62, '#000', 0.28)
    if (im) {
      const w = (im.width / im.height) * h
      g.save()
      g.globalAlpha = e.spawnT
      const s = 0.2 + 0.8 * e.spawnT
      g.translate(e.x, e.y - bob)
      g.scale(s, s)
      drawAnchored(g, im, 0, 0, w, h, 0.5, 0.5, e.faceRight)
      // What is being done to it, as a wash over the sprite: blue for slowed,
      // violet for cracked armour, orange for burning. The combos are only
      // worth building if you can see them going off.
      g.globalCompositeOperation = 'source-atop'
      for (const [on, color] of [
        [e.slow < 1, '#4fd8ff'],
        [e.shred > 0, '#b77bff'],
        [e.burn > 0, '#ff7a1f'],
      ] as const) {
        if (!on) continue
        g.globalAlpha = 0.32 * e.spawnT
        g.fillStyle = color
        g.fillRect(-w / 2, -h / 2, w, h)
      }
      g.restore()
    }
    if (e.damaged) {
      const w = def.radius * 2.2
      const ratio = Math.max(0, e.hp / e.maxHP)
      const y = e.y - h * 0.56 - 5
      g.fillStyle = 'rgba(0,0,0,0.55)'
      g.fillRect(e.x - w / 2, y - 2.5, w, 5)
      g.fillStyle = ratio > 0.5 ? '#59d959' : ratio > 0.25 ? '#f2bf33' : '#e64d40'
      g.fillRect(e.x - w / 2 + 1, y - 1.5, (w - 2) * ratio, 3)
    }
  }

  private frameTime = (e: Enemy) => Math.max(0.09, Math.min(0.2, 11 / ENEMY[e.kind].speed))

  private drawEffects(g: CanvasRenderingContext2D) {
    for (const f of this.fx as (FX & { t: number })[]) {
      const k = f.t / f.dur
      switch (f.type) {
        case 'boom': {
          const a = Math.min(1, f.t / 0.22)
          softEllipse(g, f.x, f.y, (12 + (f.radius - 12) * a) * 2, (12 + (f.radius - 12) * a) * 2, '#ff9933', 1 - k)
          for (const p of f.parts) {
            g.globalAlpha = 1 - k
            g.fillStyle = '#ffb24d'
            g.beginPath()
            g.arc(f.x + Math.cos(p.a) * p.d * k, f.y + Math.sin(p.a) * p.d * k, 4 * p.s, 0, Math.PI * 2)
            g.fill()
            g.globalAlpha = 1
          }
          break
        }
        case 'spark': {
          g.globalAlpha = 1 - k
          g.fillStyle = '#fff1c9'
          g.beginPath()
          g.arc(f.x, f.y, 7 * (1 - k), 0, Math.PI * 2)
          g.fill()
          g.globalAlpha = 1
          break
        }
        case 'puff': {
          for (const p of f.parts) {
            softEllipse(g, f.x + Math.cos(p.a) * p.d * k, f.y + Math.sin(p.a) * p.d * k, 20 * p.s, 20 * p.s, '#ffffff', (1 - k) * 0.7)
          }
          break
        }
        case 'frost': {
          g.globalAlpha = 1 - k
          g.strokeStyle = '#8cd9ff'
          g.lineWidth = 3
          g.beginPath()
          g.arc(f.x, f.y, 12 + (f.range - 12) * k, 0, Math.PI * 2)
          g.stroke()
          g.globalAlpha = 1
          break
        }
        case 'flame': {
          const fade = f.t < 0.14 ? 1 : 1 - (f.t - 0.14) / 0.14
          softEllipse(g, f.x + f.dx * k, f.y + f.dy * k, 18 * (0.5 + k), 18 * (0.5 + k), `rgb(255,${Math.round(f.hue * 255)},26)`, fade * 0.9)
          break
        }
        case 'bolt': {
          g.globalAlpha = 1 - k
          g.strokeStyle = '#b3e6ff'
          g.lineWidth = 3
          g.shadowColor = '#7fd4ff'
          g.shadowBlur = 8
          g.beginPath()
          g.moveTo(f.pts[0].x, f.pts[0].y)
          for (let i = 1; i < f.pts.length; i++) g.lineTo(f.pts[i].x, f.pts[i].y)
          g.stroke()
          g.shadowBlur = 0
          g.globalAlpha = 1
          break
        }
        case 'leak': {
          g.fillStyle = `rgba(230,38,38,${0.28 * (1 - k)})`
          g.fillRect(0, 0, C.width, C.height)
          break
        }
        case 'ring': {
          g.globalAlpha = 1 - k
          g.strokeStyle = f.color
          g.lineWidth = 4
          g.beginPath()
          g.arc(f.x, f.y, 10 + (f.radius - 10) * k, 0, Math.PI * 2)
          g.stroke()
          g.globalAlpha = 1
          break
        }
        case 'muzzle': {
          softEllipse(g, f.x, f.y, 40 * (0.6 + k), 40 * (0.6 + k), '#ffcc66', 1 - k)
          break
        }
        case 'float': {
          const up = 40 * Math.min(1, f.t / 0.95)
          const alpha = f.t < 0.5 ? 1 : Math.max(0, 1 - (f.t - 0.5) / 0.45)
          const pop = f.t < 0.14 ? 0.3 + (f.t / 0.14) * 0.85 : 1
          g.globalAlpha = alpha
          outlinedText(g, f.text, f.x + f.drift * (f.t / f.dur), f.y - up, (f.small ? 17 : 25) * pop, f.color)
          g.globalAlpha = 1
          break
        }
        case 'banner': {
          let scale = 1
          let alpha = 1
          let dy = 0
          if (f.t < 0.36) {
            const p = f.t / 0.36
            scale = 0.1 + 1.15 * Math.min(1, p * 1.6)
            alpha = Math.min(1, p * 2.5)
          } else if (f.t > 1.55) {
            const p = (f.t - 1.55) / 0.35
            alpha = 1 - p
            dy = -60 * p
            scale = 1 - 0.2 * p
          }
          g.save()
          g.globalAlpha = alpha
          g.translate(C.width / 2, C.height * 0.4 + dy)
          g.scale(scale, scale)
          softEllipse(g, 0, 0, 420, 150, '#000', 0.35 * alpha)
          outlinedText(g, f.text, 0, 0, 46, f.color, 7)
          if (f.sub) outlinedText(g, f.sub, 0, 50, 20, '#ffe27a', 4)
          g.restore()
          g.globalAlpha = 1
          break
        }
      }
    }
  }

  private drawInteraction(g: CanvasRenderingContext2D) {
    const kind = this.state.palette
    if (kind && this.ghostCell && this.pointerInside) {
      const cell = this.ghostCell
      const c = center(cell)
      const valid = this.canPlace(kind, cell)
      const s = towerStats(kind, 1)
      g.save()
      g.globalAlpha = 0.85
      g.strokeStyle = valid ? 'rgba(255,255,255,0.75)' : 'rgba(255,80,80,0.85)'
      g.fillStyle = valid ? 'rgba(255,255,255,0.12)' : 'rgba(255,50,50,0.15)'
      g.lineWidth = 2
      g.beginPath()
      g.arc(c.x, c.y, s.range, 0, Math.PI * 2)
      g.fill()
      g.stroke()
      const im = building(kind, 1)
      if (im) {
        const w = C.cell * 0.92
        const h = (im.height / im.width) * w
        drawAnchored(g, im, c.x, c.y + C.cell * 0.28, w, h, 0.5, 0.16)
      }
      g.restore()
    }
    const t = this.selectedCell ? this.towers.get(this.selectedCell) : null
    if (t) {
      const s = towerStats(t.kind, t.level)
      g.save()
      g.strokeStyle = 'rgba(255,255,255,0.75)'
      g.fillStyle = 'rgba(255,255,255,0.10)'
      g.lineWidth = 2
      g.beginPath()
      g.arc(t.x, t.y, s.range, 0, Math.PI * 2)
      g.fill()
      g.stroke()
      g.restore()
    }
  }
}
