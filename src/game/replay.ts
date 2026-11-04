// Re-runs a recorded run and reports what actually happened.
//
// This is the same Engine the browser plays, constructed without a canvas. That
// is deliberate: a second "server implementation" of the rules would drift from
// the real one within a week, and every drift looks exactly like cheating.

import { Engine, RECORD_VERSION, TICK, type GameMode, type RunRecord } from './engine'
import type { TowerKind } from './config'
import { key } from './map'

export interface ReplayResult {
  wave: number
  kills: number
  lives: number
  phase: string
  ticks: number
  /** Actions the replay could not perform — a sign the record is not genuine. */
  rejected: number
  /** Holder gold the record asked for beyond `maxBonus`, and did not get. */
  bonusClamped: number
  /** Revives the replay actually applied. */
  revives: number
}

export interface ReplayOptions {
  /**
   * Ceiling on the holder starting-gold perk, in gold.
   *
   * The record says how much bonus the player took, because the browser is
   * where the wallet balance resolves. That number is a claim, not a fact: a
   * forged `bonus` action is otherwise invisible to this replay, since the
   * simulation is perfectly happy to hand out the gold and every later action
   * then verifies cleanly. A run that asked for 1,000,000 gold replayed as a
   * legitimate six-waves-better score.
   *
   * So the caller — the server, which knows the address that signed and can
   * read its balance on chain — passes the ceiling in. Defaults to 0: a caller
   * that has not checked a balance must not grant a perk.
   */
  maxBonus?: number
  /**
   * How many of the record's revives were paid for, in order.
   *
   * Same reasoning as `maxBonus`: a `revive` action is a claim. The server
   * checks each one's burn on chain and passes the count of valid ones; any
   * revive past it is refused, the run stays dead there, and its claimed wave
   * no longer matches. Defaults to 0.
   */
  maxRevives?: number
}

// Four hours of simulated time. It was 90 minutes, which a wave 45 run already
// uses 57 of: a record breaker at wave 55 or 60 would have been cut off short of
// the wave they reached and rejected as a run that "did not replay".
const MAX_TICKS = 60 * 60 * 240

export function replayRun(record: RunRecord, opts: ReplayOptions = {}): ReplayResult {
  // A record from an older build was produced under different tables, so
  // replaying it here would disagree with it for entirely innocent reasons —
  // and a disagreement is what this function reports as cheating. Refuse it
  // instead. In practice this is a player on a cached page: they reload and the
  // next run verifies.
  if (record.version !== RECORD_VERSION) {
    throw new Error(
      `record is version ${record.version}, this build verifies version ${RECORD_VERSION}`,
    )
  }
  const maxBonus = Math.max(0, Math.floor(opts.maxBonus ?? 0))
  const maxRevives = Math.max(0, Math.floor(opts.maxRevives ?? 0))
  let revives = 0
  let bonusClamped = 0
  const mode: GameMode =
    record.mode === 'level' && record.levelId
      ? { kind: 'level', id: record.levelId }
      : { kind: 'endless' }

  const engine = new Engine(null, mode, 0, BigInt(record.seed))

  // Actions are stamped with the tick they landed on, so bucket them and apply
  // each bucket before its tick runs — the same order the live game had.
  const byTick = new Map<number, typeof record.actions>()
  for (const a of record.actions) {
    const list = byTick.get(a.tick)
    if (list) list.push(a)
    else byTick.set(a.tick, [a])
  }

  let rejected = 0
  const total = Math.min(Math.max(0, Math.floor(record.ticks)), MAX_TICKS)

  // `tickCount` is incremented after each step, so a run of N ticks ran N
  // simulations. An action stamped tick T happened after step T and before
  // step T+1 — hence apply, then step, and stop at N.
  for (let tick = 0; tick < total; tick++) {
    for (const a of byTick.get(tick) ?? []) {
      switch (a.type) {
        case 'place': {
          const ok =
            a.kind !== undefined &&
            a.x !== undefined &&
            a.y !== undefined &&
            engine.placeAt(a.kind as TowerKind, { x: a.x, y: a.y })
          if (!ok) rejected++
          break
        }
        case 'upgrade':
          if (a.x === undefined || a.y === undefined) rejected++
          else engine.upgradeAt(key({ x: a.x, y: a.y }))
          break
        case 'sell':
          if (a.x === undefined || a.y === undefined) rejected++
          else engine.sellAt(key({ x: a.x, y: a.y }))
          break
        case 'target':
          // Recorded only when it changed something, so one that changes
          // nothing here did not happen the way the record says.
          if (a.x === undefined || a.y === undefined || !a.target) rejected++
          else if (!engine.setTargetAt(key({ x: a.x, y: a.y }), a.target)) rejected++
          break
        case 'wave':
          engine.callNextWave()
          break
        case 'revive':
          if (revives < maxRevives && engine.revive()) revives++
          else rejected++
          break
        case 'bonus': {
          // Replayed as a delta at the tick it arrived, so an async wallet
          // balance lands exactly where it landed for the player — but never
          // above what the caller says this wallet is entitled to.
          const asked = Math.max(0, Math.floor(a.amount ?? 0))
          const granted = Math.min(asked, maxBonus - engine.bonusTotal)
          bonusClamped += asked - Math.max(0, granted)
          if (granted > 0) engine.grantBonus(granted + engine.bonusTotal)
          break
        }
      }
    }
    if (engine.isOver) break
    engine.step()
  }

  return {
    wave: engine.state.wave,
    kills: engine.state.kills,
    lives: engine.state.lives,
    phase: engine.state.phase,
    ticks: total,
    rejected,
    bonusClamped,
    revives,
  }
}

export { TICK }
