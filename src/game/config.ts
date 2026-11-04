// Ported 1:1 from TowerSiege/Game/GameConfig.swift — same balance numbers,
// so the web build plays exactly like the iOS build.

import { ipow } from './rng'

export const C = {
  cols: 10,
  rows: 15,
  cell: 64,
  get width() {
    return C.cols * C.cell
  },
  get height() {
    return C.rows * C.cell
  },
  startLives: 10,
  startGold: 90,
  sellRefund: 0.7,
  interludeFirst: 20,
  interlude: 10,
} as const

export type TowerKind =
  | 'ballista'
  | 'cannon'
  | 'flame'
  | 'frost'
  | 'tesla'
  | 'lance'
  | 'mortar'
  | 'beacon'
export const TOWER_KINDS: TowerKind[] = [
  'ballista',
  'cannon',
  'flame',
  'frost',
  'tesla',
  'lance',
  'mortar',
  'beacon',
]

export interface TowerStats {
  damage: number
  range: number
  fireInterval: number
  splash: number
  chain: number
  slowFactor: number
  /** Dead zone around a mortar: it lobs over anything nearer than this. */
  minRange: number
  /** Damage multiplier a beacon hands to every other tower it covers. 1 = none. */
  buff: number
  /** Ignores enemy armour outright, which is the lance's whole reason to exist. */
  pierce: boolean
}

export const TOWER_COST: Record<TowerKind, number> = {
  ballista: 30,
  cannon: 55,
  flame: 45,
  frost: 40,
  tesla: 70,
  lance: 65,
  mortar: 95,
  beacon: 50,
}

/**
 * Levels 4-5 are the endless-mode "overcharge" tiers. The campaign stops at 3.
 * They exist because a player's firepower otherwise flatlines the moment every
 * slot is built and maxed, leaving gold to pile up with nothing to buy while
 * enemy HP keeps compounding.
 */
export const MAX_LEVEL = { campaign: 3, endless: 5 } as const
export const maxTowerLevel = (endless: boolean) =>
  endless ? MAX_LEVEL.endless : MAX_LEVEL.campaign

const OVERCHARGE_COST = 1.8 // per tier above 3, compounding
const OVERCHARGE_POWER = 1.35 // per tier above 3, compounding

export function upgradeCost(kind: TowerKind, toLevel: number): number {
  const base = TOWER_COST[kind]
  if (toLevel <= 2) return Math.round(base * 1.2)
  const over = Math.max(0, toLevel - 3)
  return Math.round(base * 2.0 * ipow(OVERCHARGE_COST, over))
}

/** Everything a tower does not do, so each case below only states its own idea. */
const NONE = { splash: 0, chain: 0, slowFactor: 1, minRange: 0, buff: 1, pierce: false }

/**
 * A tower's numbers at a level. Asked for by every tower on every tick, and
 * more than once (the beacon lookup asks again for each beacon), so each
 * answer is worked out once and kept. Building a fresh object per call was 74%
 * of a long replay's time, and on the server's Node 20 that made a wave 45 run
 * take 95 seconds to verify. The result is shared: callers must not mutate it.
 */
const statsCache = new Map<TowerKind, TowerStats[]>()

export function towerStats(kind: TowerKind, level: number): Readonly<TowerStats> {
  let byLevel = statsCache.get(kind)
  if (!byLevel) statsCache.set(kind, (byLevel = []))
  return (byLevel[level] ??= computeTowerStats(kind, level))
}

function computeTowerStats(kind: TowerKind, level: number): TowerStats {
  if (level > 3) {
    const over = level - 3
    const s = towerStats(kind, 3)
    const power = ipow(OVERCHARGE_POWER, over)
    return {
      damage: s.damage * power,
      range: s.range * (1 + 0.06 * over),
      fireInterval: s.fireInterval,
      splash: s.splash * (1 + 0.1 * over),
      chain: s.chain > 0 ? s.chain + over : 0,
      slowFactor: s.slowFactor < 1 ? s.slowFactor * ipow(0.85, over) : 1,
      // The dead zone does not grow with the range: an overcharged mortar should
      // cover more ground, not refuse more of it.
      minRange: s.minRange,
      buff: s.buff > 1 ? 1 + (s.buff - 1) * ipow(1.18, over) : 1,
      pierce: s.pierce,
    }
  }
  const i = Math.max(0, Math.min(2, level - 1))
  switch (kind) {
    case 'ballista':
      return {
        ...NONE,
        damage: [13, 24, 42][i],
        range: [180, 200, 225][i],
        fireInterval: [0.85, 0.7, 0.55][i],
      }
    case 'cannon':
      return {
        ...NONE,
        damage: [26, 46, 80][i],
        range: [140, 155, 175][i],
        fireInterval: [1.7, 1.5, 1.3][i],
        splash: [58, 68, 80][i],
      }
    case 'flame':
      return {
        ...NONE,
        damage: [3.0, 5.2, 8.6][i],
        range: [105, 120, 138][i],
        fireInterval: 0.12,
      }
    case 'frost':
      return {
        ...NONE,
        damage: 0,
        range: [115, 132, 150][i],
        fireInterval: 0.5,
        slowFactor: [0.62, 0.5, 0.38][i],
      }
    case 'tesla':
      return {
        ...NONE,
        damage: [20, 34, 56][i],
        range: [150, 165, 185][i],
        fireInterval: [1.1, 1.0, 0.85][i],
        chain: [3, 4, 6][i],
      }
    /**
     * Single target, slow, and it ignores armour. Against an unarmoured wave a
     * ballista out-damages it for half the price; against an armoured one it is
     * the only tower whose damage does not get shaved every hit.
     */
    case 'lance':
      return {
        ...NONE,
        damage: [34, 60, 104][i],
        range: [190, 210, 235][i],
        fireInterval: [1.35, 1.2, 1.05][i],
        pierce: true,
      }
    /**
     * Reaches most of the board, which nothing else does. The dead zone is the
     * price: a mortar cannot defend its own tile, so it wants to sit behind the
     * line rather than on it.
     */
    case 'mortar':
      return {
        ...NONE,
        // Priced for uptime, not for damage on paper. A tower that reaches this
        // far is firing almost continuously while a ballista spends half the
        // wave with nothing in range, so raw output has to be lower or the
        // answer to every board is "buy mortars". Measured: at 55/95/165 a
        // mortar-only board beat every mixed build by 22%.
        damage: [40, 70, 122][i],
        // Same measurement, other half of the fix: at 320-410 one mortar
        // covered so much of the map that where you put it stopped mattering.
        range: [270, 300, 335][i],
        fireInterval: [2.6, 2.4, 2.2][i],
        splash: [70, 80, 95][i],
        minRange: 120,
      }
    /**
     * Deals no damage at all. It multiplies the damage of every other tower in
     * range, which turns placement into a real decision: spread out to cover
     * more path, or bunch up and hit far harder over less of it.
     */
    case 'beacon':
      return {
        ...NONE,
        damage: 0,
        range: [110, 128, 148][i],
        fireInterval: 1,
        buff: [1.15, 1.25, 1.4][i],
      }
  }
}

/**
 * Who a tower shoots at, chosen per tower.
 *
 * Every tower used to shoot whoever was furthest along the path, and nothing
 * else. That is the right answer for stopping a leak and the wrong one for a
 * lance: a boss walks in the middle of its escort, so the boss killer spent
 * the boss wave on the grunts in front. The choice is the player's now.
 *
 * - first: furthest along the path. What every tower did before.
 * - strong: the biggest enemy in range, a boss before a brute before a grunt;
 *   among equals, the one furthest along. Ranked by full health rather than
 *   health left, so the tower stays on one target until it falls instead of
 *   spreading its shots around.
 * - armored: armoured enemies first, then furthest along.
 */
export type TargetMode = 'first' | 'strong' | 'armored'
export const TARGET_MODES: TargetMode[] = ['first', 'strong', 'armored']

/**
 * Whether a tower aims at all. Flame breathes on everything in range, frost
 * and beacon never fire, so for those three a target would change nothing.
 */
export const aims = (kind: TowerKind) => kind !== 'flame' && kind !== 'frost' && kind !== 'beacon'

/**
 * Towers that make each other better. Each one gives a tower that is weak on
 * its own a reason to be on the board, and makes a mixed board beat a board of
 * one kind:
 *
 * - Frost + Tesla: lightning does `teslaChill` times the damage to an enemy that
 *   is slowed. Frost does no damage at all, so this is its payoff.
 * - Mortar + everything: a mortar shell cracks the armour of what it hits for
 *   `shredTime` seconds, and every hit on it lands in full. Armour shaves each
 *   hit, so the towers that fire fastest (flame, ballista, tesla) gain most.
 * - Flame: an enemy flame has touched in the last `burnTime` seconds explodes
 *   when it dies, for `burstShare` of its full health on everything within
 *   `burstRadius`. A share of health rather than a flat number, so it still
 *   matters at wave 50, and a burning boss takes its escort with it.
 */
export const COMBO = {
  teslaChill: 1.5,
  shredTime: 3,
  burnTime: 1,
  burstShare: 0.12,
  burstRadius: 70,
} as const

export type TowerStatKey = 'damage' | 'flame' | 'frost' | 'tesla' | 'beacon' | 'mortar' | 'lance'

/**
 * The one-line readout for a tower, as a string key and its numbers.
 *
 * Lives here because two places need the same answer: the panel for a tower
 * already standing on the board, and the panel that previews a tower you have
 * only picked from the palette. Working it out twice is how the two drift apart.
 *
 * `boost` is what a nearby beacon is contributing, so the figure on screen is
 * what the tower actually fires with rather than what it costs.
 */
export function towerReadout(
  kind: TowerKind,
  level: number,
  boost = 1,
): { statKey: TowerStatKey; statArgs: number[] } {
  const s = towerStats(kind, level)
  const dmg = Math.round(s.damage * boost)
  switch (kind) {
    case 'frost':
      return { statKey: 'frost', statArgs: [Math.round((1 - s.slowFactor) * 100), Math.round(s.range)] }
    case 'flame':
      return { statKey: 'flame', statArgs: [Math.round(dmg / s.fireInterval), Math.round(s.range)] }
    case 'tesla':
      return { statKey: 'tesla', statArgs: [dmg, s.chain, Math.round(s.range)] }
    case 'beacon':
      return { statKey: 'beacon', statArgs: [Math.round((s.buff - 1) * 100), Math.round(s.range)] }
    case 'mortar':
      return { statKey: 'mortar', statArgs: [dmg, Math.round(s.minRange), Math.round(s.range)] }
    case 'lance':
      return { statKey: 'lance', statArgs: [dmg, Math.round(s.range)] }
    default:
      return { statKey: 'damage', statArgs: [dmg, Math.round(s.range)] }
  }
}

export type EnemyKind = 'runner' | 'grunt' | 'brute' | 'boss' | 'armored'

interface EnemyDef {
  hpMult: number
  speed: number
  goldMult: number
  livesCost: number
  radius: number
  /** Share of the wave's armour this kind carries. 0 for everything soft. */
  armorMult: number
}

export const ENEMY: Record<EnemyKind, EnemyDef> = {
  runner: { hpMult: 0.55, speed: 118, goldMult: 0.8, livesCost: 1, radius: 13, armorMult: 0 },
  grunt: { hpMult: 1.0, speed: 78, goldMult: 1, livesCost: 1, radius: 16, armorMult: 0 },
  brute: { hpMult: 2.8, speed: 54, goldMult: 2.2, livesCost: 1, radius: 21, armorMult: 0 },
  boss: { hpMult: 22, speed: 40, goldMult: 18, livesCost: 3, radius: 28, armorMult: 0 },
  armored: { hpMult: 1.6, speed: 66, goldMult: 1.6, livesCost: 1, radius: 18, armorMult: 1 },
}

/**
 * Armour is subtracted from **each hit**, which is the whole point of it: it
 * barely troubles a mortar shell and it all but stops a flame tick. A flat
 * number would stop mattering as damage compounds, so it drifts up with the
 * wave — slowly, because it is a counter, not a wall.
 *
 * Never a full stop: `damage()` keeps a floor, so a player who built nothing but
 * flame still kills armoured enemies, just far too slowly to be doing it on
 * purpose. Without that floor such a board would stall on a wave forever.
 */
export const armorFor = (wave: number) => 6 + wave * 0.5

/** First endless wave that mixes armour in. */
const ARMORED_FROM = 8

/**
 * Turns a share of the heavies into armoured ones.
 *
 * Endless only. The 48 campaign levels were balanced against the original tables
 * with a simulator and their star thresholds move if the composition changes,
 * so the campaign keeps the waves it was tuned for.
 */
function withArmored(
  entries: { kind: EnemyKind; count: number }[],
  wave: number,
  endless: boolean,
): { kind: EnemyKind; count: number }[] {
  if (!endless || wave < ARMORED_FROM) return entries
  const share = Math.min(0.4, 0.15 + (wave - ARMORED_FROM) * 0.012)
  const out: { kind: EnemyKind; count: number }[] = []
  let armored = 0
  for (const e of entries) {
    if (e.kind === 'grunt' || e.kind === 'brute') {
      const take = Math.floor(e.count * share)
      armored += take
      if (e.count - take > 0) out.push({ kind: e.kind, count: e.count - take })
    } else {
      out.push(e)
    }
  }
  if (armored > 0) out.push({ kind: 'armored', count: armored })
  return out
}

/**
 * Endless-only tuning. The campaign keeps the original numbers: its 48 levels
 * were balanced against them with a simulator, and shifting HP or income would
 * move every star threshold.
 *
 * Measured problem this fixes: with the original curve a player's firepower
 * flatlines around wave 15 (everything built and maxed) while enemy HP keeps
 * compounding, so waves 8-20 ask for barely 10-20% of the player's output and
 * the run then falls off a cliff with thousands of unspendable gold.
 *
 * The growth rate below is paired with the overcharge tiers (levels 4-5): those
 * raise the player's ceiling, so the enemy curve can be steeper without the run
 * simply ending sooner. Simulated at six towers, the load per wave now runs
 * 0.19 / 0.38 / 0.74 at waves 12 / 16 / 20 instead of 0.09 / 0.19 / 0.41, and
 * spare gold at wave 18 drops from ~1200 to ~250.
 */
export const ENDLESS = {
  hpGrowth: 1.2, // campaign: 1.17
  /**
   * From this wave on HP grows by `lateGrowth` instead, and the boss is
   * softened below. Measured with tools/balance-sim.mjs, a bot calibrated to
   * where real players died:
   *
   * 2026-10-12: at 1.2 all the way wave 31 was a wall nobody passed, revives
   * included (median 30). 1.15 past 25 moved the median to 31, no further.
   *
   * 2026-10-13, after "you can't kill the wave 30 bosses and reach 31 on one
   * life": waves 27-29 cost no lives at all, wave 30's three bosses took 9 of
   * 10, and wave 31 took the last one. Two walls back to back, so both are
   * eased: 1.12 here, and the boss below. Median now 34, wave 31 passed in 10
   * runs of 12, three revives go further still. Hard, not impossible.
   */
  lateFrom: 25,
  lateGrowth: 1.12,
  /** The endless boss: 14x a grunt's HP (campaign 22x), and 2 lives if it leaks (campaign 3). */
  bossHpMult: 14,
  bossLivesCost: 2,
  goldScale: 0.85,
  countCap: 55, // campaign: 42
  bonusBase: 14, // campaign: 18
  bonusPerWave: 1.6, // campaign: 2
} as const

/**
 * An enemy's row for the mode being played. The campaign uses ENEMY as it is:
 * its 48 levels and their star thresholds were balanced against it. Endless
 * softens the boss (see ENDLESS).
 */
export function enemyDef(kind: EnemyKind, endless: boolean): EnemyDef {
  if (endless && kind === 'boss') {
    return { ...ENEMY.boss, hpMult: ENDLESS.bossHpMult, livesCost: ENDLESS.bossLivesCost }
  }
  return ENEMY[kind]
}

export interface WavePlan {
  entries: { kind: EnemyKind; count: number }[]
  spawnInterval: number
  baseHP: number
  goldPerKill: number
  isBossWave: boolean
}

export function wavePlan(wave: number, endless = false): WavePlan {
  const baseHP = !endless
    ? 26 * ipow(1.17, wave - 1)
    : wave <= ENDLESS.lateFrom
      ? 26 * ipow(ENDLESS.hpGrowth, wave - 1)
      : 26 * ipow(ENDLESS.hpGrowth, ENDLESS.lateFrom - 1) * ipow(ENDLESS.lateGrowth, wave - ENDLESS.lateFrom)
  const gold = (2.0 + wave * 0.12) * (endless ? ENDLESS.goldScale : 1)
  const interval = Math.max(0.45, 0.95 - wave * 0.012)

  if (wave % 10 === 0) {
    const bossCount = Math.floor(wave / 10)
    return {
      entries: withArmored(
        [
          { kind: 'boss', count: bossCount },
          { kind: 'grunt', count: Math.min(20, 6 + Math.floor(wave / 2)) },
        ],
        wave,
        endless,
      ),
      spawnInterval: interval * 1.6,
      baseHP,
      goldPerKill: gold,
      isBossWave: true,
    }
  }

  const total = Math.min(endless ? ENDLESS.countCap : 42, 9 + wave * 2)
  let entries: { kind: EnemyKind; count: number }[]
  switch (wave % 5) {
    case 1:
      entries = [{ kind: 'grunt', count: total }]
      break
    case 2:
      entries = [
        { kind: 'grunt', count: Math.floor((total * 2) / 3) },
        { kind: 'runner', count: Math.floor(total / 3) },
      ]
      break
    case 3:
      entries = [{ kind: 'runner', count: total }]
      break
    case 4:
      entries = [
        { kind: 'grunt', count: Math.floor(total / 2) },
        { kind: 'brute', count: Math.max(2, Math.floor(total / 4)) },
      ]
      break
    default:
      entries = [
        { kind: 'brute', count: Math.max(3, Math.floor(total / 3)) },
        { kind: 'runner', count: Math.floor(total / 3) },
      ]
  }
  return {
    entries: withArmored(entries, wave, endless),
    spawnInterval: interval,
    baseHP,
    goldPerKill: gold,
    isBossWave: false,
  }
}

/**
 * Calling the next wave while the current one is still on the field pays its
 * completion bonus at once plus up to this share of it again, scaled by how
 * much of the wave is still standing. Asked for by the owner on 2026-11-02:
 * the player who takes the risk early should come out with more gold.
 *
 * Measured with tools/balance-sim.mjs, 20 maps: a bot that always calls early
 * dies sooner on the median (36 against 45) and goes a little further at best
 * (51 against 50), at 0.5 and at 1 alike. Two waves at once is the price, so
 * the reward can be the full bonus again.
 */
export const EARLY_CALL_SHARE = 1

export function completionBonus(wave: number, endless = false): number {
  return endless
    ? Math.round(ENDLESS.bonusBase + wave * ENDLESS.bonusPerWave)
    : 18 + wave * 2
}
