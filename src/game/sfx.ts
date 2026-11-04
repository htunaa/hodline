// Tiny WebAudio synth — the web counterpart of the generated .wav bank on iOS.
// No assets, no latency, and it stays silent until the first user gesture.

type Name =
  | 'shoot' | 'cannon' | 'boom' | 'zap' | 'coin' | 'place'
  | 'upgrade' | 'sell' | 'wave' | 'leak' | 'gameover' | 'victory' | 'tap'

interface Tone {
  type: OscillatorType
  from: number
  to: number
  dur: number
  gain: number
  noise?: boolean
}

const BANK: Record<Name, Tone[]> = {
  shoot: [{ type: 'triangle', from: 780, to: 320, dur: 0.07, gain: 0.1 }],
  cannon: [{ type: 'square', from: 180, to: 60, dur: 0.16, gain: 0.16, noise: true }],
  boom: [{ type: 'sawtooth', from: 140, to: 40, dur: 0.28, gain: 0.16, noise: true }],
  zap: [{ type: 'square', from: 1400, to: 240, dur: 0.11, gain: 0.09 }],
  coin: [
    { type: 'triangle', from: 980, to: 980, dur: 0.05, gain: 0.07 },
    { type: 'triangle', from: 1480, to: 1480, dur: 0.07, gain: 0.06 },
  ],
  place: [{ type: 'sine', from: 300, to: 520, dur: 0.11, gain: 0.14 }],
  upgrade: [
    { type: 'sine', from: 520, to: 760, dur: 0.09, gain: 0.12 },
    { type: 'sine', from: 760, to: 1040, dur: 0.12, gain: 0.11 },
  ],
  sell: [{ type: 'sine', from: 600, to: 240, dur: 0.14, gain: 0.11 }],
  wave: [
    { type: 'sawtooth', from: 220, to: 330, dur: 0.16, gain: 0.09 },
    { type: 'sawtooth', from: 330, to: 440, dur: 0.2, gain: 0.08 },
  ],
  leak: [{ type: 'sawtooth', from: 240, to: 90, dur: 0.3, gain: 0.14 }],
  gameover: [
    { type: 'sawtooth', from: 330, to: 220, dur: 0.3, gain: 0.12 },
    { type: 'sawtooth', from: 220, to: 110, dur: 0.5, gain: 0.12 },
  ],
  victory: [
    { type: 'triangle', from: 523, to: 523, dur: 0.12, gain: 0.11 },
    { type: 'triangle', from: 659, to: 659, dur: 0.12, gain: 0.11 },
    { type: 'triangle', from: 784, to: 1046, dur: 0.28, gain: 0.12 },
  ],
  tap: [{ type: 'sine', from: 660, to: 660, dur: 0.04, gain: 0.06 }],
}

class Sfx {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  // Guarded: this module is also imported by the headless replay running in
  // Node, where there is no localStorage at all.
  muted = (() => {
    try {
      return localStorage.getItem('muted') === '1'
    } catch {
      return true
    }
  })()
  /** 0 to 1, remembered like `muted`. Separate from it, so unmuting returns to the level you chose. */
  volume = (() => {
    try {
      const v = Number(localStorage.getItem('volume') ?? '1')
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
    } catch {
      return 1
    }
  })()
  private noiseBuf: AudioBuffer | null = null
  private listeners = new Set<() => void>()

  /** For the controls on screen, so a keyboard toggle and a click stay in agreement. */
  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  private changed() {
    for (const fn of this.listeners) fn()
  }

  private ensure() {
    if (this.ctx) return this.ctx
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    this.ctx = new Ctor()
    this.master = this.ctx.createGain()
    this.master.gain.value = 0.75 * this.volume
    this.master.connect(this.ctx.destination)
    const len = this.ctx.sampleRate * 0.3
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const d = this.noiseBuf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len)
    return this.ctx
  }

  resume() {
    const c = this.ensure()
    if (c?.state === 'suspended') void c.resume()
  }

  setMuted(v: boolean) {
    this.muted = v
    try {
      localStorage.setItem('muted', v ? '1' : '0')
    } catch {
      /* no storage, nothing to remember */
    }
    this.changed()
  }

  setVolume(v: number) {
    this.volume = Math.min(1, Math.max(0, v))
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(0.75 * this.volume, this.ctx.currentTime, 0.02)
    try {
      localStorage.setItem('volume', String(this.volume))
    } catch {
      /* no storage, nothing to remember */
    }
    // Dragging the slider up is an obvious request to hear something.
    if (this.volume > 0 && this.muted) this.setMuted(false)
    else this.changed()
  }

  /** Silences everything without touching the saved setting: a restored run fast-forwarding. */
  hold = false

  play(name: Name) {
    if (this.hold || this.muted || this.volume === 0) return
    const ctx = this.ensure()
    if (!ctx || !this.master) return
    const now = ctx.currentTime
    let offset = 0
    for (const tone of BANK[name]) {
      const gain = ctx.createGain()
      gain.gain.setValueAtTime(tone.gain, now + offset)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + tone.dur)
      gain.connect(this.master)
      const osc = ctx.createOscillator()
      osc.type = tone.type
      osc.frequency.setValueAtTime(tone.from, now + offset)
      if (tone.to !== tone.from) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, tone.to), now + offset + tone.dur)
      }
      osc.connect(gain)
      osc.start(now + offset)
      osc.stop(now + offset + tone.dur)
      if (tone.noise && this.noiseBuf) {
        const src = ctx.createBufferSource()
        src.buffer = this.noiseBuf
        const ng = ctx.createGain()
        ng.gain.setValueAtTime(tone.gain * 0.7, now + offset)
        ng.gain.exponentialRampToValueAtTime(0.0001, now + offset + tone.dur)
        src.connect(ng)
        ng.connect(this.master)
        src.start(now + offset)
        src.stop(now + offset + tone.dur)
      }
      offset += tone.dur * 0.55
    }
  }
}

export const sfx = new Sfx()
