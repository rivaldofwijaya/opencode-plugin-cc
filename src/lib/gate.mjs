import { join } from 'node:path'
import { stateRoot, readJson, writeJson } from './state.mjs'

export const gateStatePath = (env = process.env) => join(stateRoot(env), 'gate.json')

export async function readGate(env = process.env) {
  return (await readJson(gateStatePath(env), { on: false })).on === true
}

export async function writeGate(on, env = process.env) {
  await writeJson(gateStatePath(env), { on: Boolean(on), updatedAt: Date.now() })
}
