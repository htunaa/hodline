// localStorage mirror of Progress (UserDefaults) from the iOS build.

import { LEVEL_COUNT } from './levels'

const read = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* private mode */
  }
}

const num = (k: string) => parseInt(read(k) ?? '0', 10) || 0

export const Progress = {
  get maxUnlockedLevel() {
    return Math.max(1, num('maxUnlockedLevel'))
  },
  set maxUnlockedLevel(v: number) {
    write('maxUnlockedLevel', String(v))
  },
  get bestWave() {
    return num('bestWave')
  },
  set bestWave(v: number) {
    write('bestWave', String(v))
  },
  get tutorialDone() {
    return read('tutorialDone') === '1'
  },
  set tutorialDone(v: boolean) {
    write('tutorialDone', v ? '1' : '0')
  },
  stars(level: number) {
    return num(`stars_L${level}`)
  },
  recordWin(level: number, livesLeft: number): number {
    const stars = livesLeft >= 9 ? 3 : livesLeft >= 6 ? 2 : 1
    if (stars > Progress.stars(level)) write(`stars_L${level}`, String(stars))
    if (level + 1 > Progress.maxUnlockedLevel && level < LEVEL_COUNT) {
      Progress.maxUnlockedLevel = level + 1
    }
    return stars
  },
  get totalStars() {
    let n = 0
    for (let i = 1; i <= LEVEL_COUNT; i++) n += Progress.stars(i)
    return n
  },
}
