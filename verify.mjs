// Replays a recorded run and prints what really happened.
//
//   npm install
//   npm run build
//   node verify.mjs examples/endless-wave-51.json
//
// This is the same check the Hodline server runs on every submitted score.

import { readFileSync } from 'node:fs'
import { replayRun } from './dist/replay.mjs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node verify.mjs <record.json>')
  process.exit(1)
}

const record = JSON.parse(readFileSync(file, 'utf8'))
const started = Date.now()
const result = replayRun(record)
const ms = Date.now() - started

console.log(`mode     ${record.mode}${record.levelId ? ` (level ${record.levelId})` : ''}`)
console.log(`seed     ${record.seed}`)
console.log(`actions  ${record.actions.length}`)
console.log(`ticks    ${result.ticks}`)
console.log(`wave     ${result.wave}`)
console.log(`kills    ${result.kills}`)
console.log(`lives    ${result.lives}`)
console.log(`rejected ${result.rejected}`)
console.log(`score    ${result.wave * 1000 + result.kills}`)
console.log(`\nreplayed in ${ms} ms`)
console.log(result.rejected === 0 ? 'OK: every action replayed cleanly' : 'REJECTED: the record asks for moves the game would not allow')
