# opencode-plugin-cc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Claude Code plugin named `opencode` that delegates code review and coding tasks to the local `opencode` CLI via a lazily-started, refcounted local HTTP+SSE server.

**Architecture:** Eight markdown commands invoke one Node entrypoint, `scripts/opencode-companion.mjs`. The companion resolves the opencode binary off-PATH, lazily spawns a shared `opencode serve` broker (spawn-once via lockfile + portfile), drives jobs over `POST /session` + `POST /session/:id/prompt_async` + `GET /global/event` (SSE), and persists per-Claude-Code-session job records under a state dir. Every module in `scripts/lib/` has one responsibility and is unit-tested against a fake binary fixture placed first on PATH.

**Tech Stack:** Plain Node ESM (`.mjs`), built-in `fetch`, built-in `node --test`. Zero runtime dependencies, no build step, no install step.

## Global Constraints

Every task's requirements implicitly include this section.

- **Node floor: 22.** Uses built-in `fetch`, `node --test`, `node:test` `describe`/`it`. No transpilation.
- **opencode floor: 1.18.0.** Verified dev machine runs 1.18.11 at `~/.opencode/bin/opencode`.
- **Zero runtime dependencies.** No `dependencies` in `package.json`, ever. No bundler, no build artifacts. Dev-time is also empty — tests use `node --test` only.
- **Plugin name is `opencode`.** Commands namespace as `/opencode:<verb>`.
- **All source is ESM `.mjs`.** No `.ts`, no CommonJS. The one `.d.ts` (`server-protocol.d.ts`) is hand-written documentation-only types, never compiled.
- **Every command returns companion stdout verbatim** — no paraphrase, summary, or added commentary. Command markdown must say this explicitly.
- **Errors are a non-zero exit code plus a human-readable message on stderr.** Nothing is swallowed.
- **No telemetry of any kind.**
- **State dir:** `${XDG_STATE_HOME:-$HOME/.local/state}/opencode-plugin-cc/`.
- **Credentials file:** `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json`, mode `0600`.
- **Config files:** project `./opencode.json` or `./opencode.jsonc`, then global `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json` or `opencode.jsonc`.
- **Never print, echo, or read back an API key.** Redacted confirmations only.
- **Commit after every task.** Conventional commit messages (`feat:`, `test:`, `fix:`, `chore:`).

## Spec drift found during planning (2026-08-02)

Verified on the dev machine while writing this plan. These override the spec's §2 table:

1. **The global config now exists** as `~/.config/opencode/opencode.jsonc` — note the **`.jsonc`** extension — containing `{"$schema": "https://opencode.ai/config.json", "model": "openrouter/deepseek/deepseek-v4-flash-0731"}`. The spec assumed it was absent and only ever named `opencode.json`. Consequence: config resolution and `set-model` must handle **both** `.json` and `.jsonc`, must strip `//` and `/* */` comments when reading, and must prefer an existing file's extension when writing rather than creating a second file.
2. **`opencode serve` warns `OPENCODE_SERVER_PASSWORD is not set; server is unsecured`** and `opencode run` exposes `-p/--password` / `-u/--username` (basic auth, default username `opencode`). The broker therefore generates a random password, passes it to the child via env, and the HTTP client sends `Authorization: Basic`. Task 8 verifies this against the real binary and documents the fallback if the running version ignores it.
3. **`opencode auth list` prints a styled TUI box with ANSI escapes** (`┌ Credentials`, `● OpenRouter api`, `└ 1 credentials`), not machine-readable output. Auth detection therefore reads `auth.json` directly and treats `auth list` as a non-authoritative cross-check only.
4. **Confirmed live wire facts** (used verbatim below): SSE frames are `data: {"payload":{"id":"evt_…","type":"…","properties":{…}}}`; `POST /session` body accepts `{title, agent, model:{providerID,id,variant}, permission}` and returns `{id: "ses…", …}`; `POST /session/:id/prompt_async` body is `{parts:[…], agent?, model?:{providerID,modelID}, variant?, system?, tools?}`; terminal events are `session.idle` and `session.error`.

## Additions to the spec's §4.3 module table

The spec's module table omits three responsibilities that §6 and §5.1 require. These are added and called out here so the decomposition is explicit:

- `scripts/lib/credentials.mjs` — read `auth.json`, implement `set-key` (merge, backup, atomic, `0600`).
- `scripts/lib/config.mjs` — resolve the effective default model, implement `set-model` (merge-write into the right `opencode.json`/`.jsonc`).
- `scripts/lib/review-schema.mjs` — parse and validate model output against `schemas/review-output.schema.json` without a dependency.

## File Structure

```
.claude-plugin/plugin.json          plugin manifest (name: opencode)
.claude-plugin/marketplace.json     marketplace entry for /plugin marketplace add
package.json                        name, type: module, test script. NO dependencies.
commands/                           review.md adversarial-review.md rescue.md transfer.md
                                    status.md result.md cancel.md setup.md
agents/opencode-rescue.md           thin forwarder subagent
skills/opencode-server-runtime/SKILL.md
skills/opencode-result-handling/SKILL.md
hooks/hooks.json                    SessionStart / SessionEnd / Stop wiring
prompts/                            review.md adversarial-review.md stop-review-gate.md
schemas/review-output.schema.json   findings contract
scripts/opencode-companion.mjs      single entrypoint; verb dispatch only
scripts/server-broker.mjs           broker child process
scripts/session-lifecycle-hook.mjs  SessionStart + SessionEnd
scripts/stop-review-gate-hook.mjs   Stop gate
scripts/lib/fs.mjs                  atomic write, backup, merge-write, JSONC read
scripts/lib/state.mjs               state dir layout, atomic JSON/JSONL
scripts/lib/opencode.mjs            binary resolution, version, argv/flag mapping
scripts/lib/args.mjs                companion argv parsing
scripts/lib/credentials.mjs         auth.json read + set-key
scripts/lib/config.mjs              model resolution + set-model
scripts/lib/process.mjs             spawn, timeout, signals
scripts/lib/server.mjs              HTTP + SSE client
scripts/lib/server-protocol.d.ts    hand-written wire types
scripts/lib/broker-endpoint.mjs     portfile read/write, base URL
scripts/lib/broker-lifecycle.mjs    spawn-once, refcount, health, reap
scripts/lib/tracked-jobs.mjs        per-CC-session job records
scripts/lib/job-control.mjs         start / observe / cancel
scripts/lib/git.mjs                 scope resolution, diff, sizing
scripts/lib/prompts.mjs             prompt template loading
scripts/lib/review-schema.mjs       review JSON parse + validate
scripts/lib/render.mjs              terminal rendering
scripts/lib/claude-session-transfer.mjs  CC conversation snapshot
tests/fake-opencode-fixture.mjs     fake binary: --version, auth list, models, serve
tests/unit/                         per-module unit tests
tests/integration/                  companion against the fixture
tests/isolated/                     real binary, temp HOME/XDG
tests/live/                         real binary, real credentials, OPENCODE_LIVE=1
tests/lint-commands.test.mjs        prompts/code drift check
```

---

## Task 1: Repo skeleton, manifests, and test harness

**Files:**
- Create: `package.json`, `.gitignore`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `README.md`
- Test: `tests/unit/manifests.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` runs `node --test`; the plugin manifest declares name `opencode`, `commands`, `agents`, `skills`, and `hooks/hooks.json`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/manifests.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const read = (p) => JSON.parse(readFileSync(root + p, 'utf8'))

test('plugin manifest declares the opencode plugin', () => {
  const m = read('.claude-plugin/plugin.json')
  assert.equal(m.name, 'opencode')
  assert.ok(m.description.length > 0)
  assert.equal(m.hooks, './hooks/hooks.json')
})

test('marketplace entry points at this plugin', () => {
  const m = read('.claude-plugin/marketplace.json')
  assert.equal(m.name, 'opencode-plugin-cc')
  assert.equal(m.plugins.length, 1)
  assert.equal(m.plugins[0].name, 'opencode')
  assert.equal(m.plugins[0].source, './')
})

test('package declares zero runtime dependencies', () => {
  const p = read('package.json')
  assert.equal(p.type, 'module')
  assert.deepEqual(p.dependencies ?? {}, {})
  assert.deepEqual(p.devDependencies ?? {}, {})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/manifests.test.mjs`
Expected: FAIL — `ENOENT: no such file or directory, open '.../package.json'`

- [ ] **Step 3: Write the manifests**

`package.json`:

```json
{
  "name": "opencode-plugin-cc",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "node --test tests/unit tests/integration tests/lint-commands.test.mjs",
    "test:isolated": "node --test tests/isolated",
    "test:live": "OPENCODE_LIVE=1 node --test tests/live"
  }
}
```

`.claude-plugin/plugin.json`:

```json
{
  "name": "opencode",
  "description": "Delegate code review and coding tasks to the opencode CLI from Claude Code.",
  "version": "0.1.0",
  "commands": "./commands",
  "agents": "./agents",
  "skills": "./skills",
  "hooks": "./hooks/hooks.json"
}
```

`.claude-plugin/marketplace.json`:

```json
{
  "name": "opencode-plugin-cc",
  "owner": { "name": "opencode-plugin-cc" },
  "plugins": [
    {
      "name": "opencode",
      "source": "./",
      "description": "Delegate code review and coding tasks to the opencode CLI."
    }
  ]
}
```

`.gitignore`:

```
node_modules/
*.log
.DS_Store
```

`README.md`: one paragraph stating what the plugin does, the install line `/plugin marketplace add <repo>`, the opencode 1.18.0 floor, and "run `/opencode:setup` first".

- [ ] **Step 4: Create empty test dirs so `npm test` does not error**

```bash
mkdir -p tests/unit tests/integration tests/isolated tests/live commands agents skills prompts schemas hooks scripts/lib
printf 'import { test } from "node:test"\nimport assert from "node:assert/strict"\ntest("placeholder", () => assert.ok(true))\n' > tests/integration/placeholder.test.mjs
printf 'import { test } from "node:test"\nimport assert from "node:assert/strict"\ntest("placeholder", () => assert.ok(true))\n' > tests/lint-commands.test.mjs
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 5 tests

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: repo skeleton, plugin manifests, node --test harness"
```

---

## Task 2: `lib/fs.mjs` — atomic write, backup, merge-write, JSONC read

This is where silent data loss would live. Test it harder than anything else.

**Files:**
- Create: `scripts/lib/fs.mjs`
- Test: `tests/unit/fs.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `atomicWrite(path: string, contents: string, opts?: {mode?: number}): Promise<void>` — writes `path.tmp-<pid>-<counter>` in the same directory then `rename`s; applies `mode` (default `0o644`) to the temp file before rename.
  - `backupFile(path: string): Promise<string|null>` — copies to `<path>.bak` preserving mode; returns the backup path, or `null` if the source does not exist.
  - `readJsonc(path: string): Promise<any|null>` — reads and parses JSON with `//` and `/* */` comments stripped; returns `null` if the file does not exist; throws on malformed JSON.
  - `mergeWriteJson(path: string, patch: object, opts?: {mode?: number, schemaUrl?: string}): Promise<{backup: string|null, created: boolean}>` — reads existing (via `readJsonc`), shallow-merges `patch` over it, adds `$schema: schemaUrl` when creating a new file and `schemaUrl` is given, writes atomically at `mode`, backing up first.
  - `stripJsonComments(text: string): string` — exported for direct testing; must not strip `//` inside string literals.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/fs.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, stat, chmod, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite, backupFile, readJsonc, mergeWriteJson, stripJsonComments } from '../../scripts/lib/fs.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'ocfs-'))

test('atomicWrite writes contents and leaves no temp files behind', async () => {
  const d = await tmp()
  const f = join(d, 'a.json')
  await atomicWrite(f, '{"a":1}')
  assert.equal(await readFile(f, 'utf8'), '{"a":1}')
  assert.deepEqual(await readdir(d), ['a.json'])
})

test('atomicWrite honours mode 0600', async () => {
  const d = await tmp()
  const f = join(d, 'auth.json')
  await atomicWrite(f, '{}', { mode: 0o600 })
  assert.equal((await stat(f)).mode & 0o777, 0o600)
})

test('atomicWrite overwrites an existing file without truncating on failure', async () => {
  const d = await tmp()
  const f = join(d, 'a.json')
  await writeFile(f, 'old')
  await atomicWrite(f, 'new')
  assert.equal(await readFile(f, 'utf8'), 'new')
})

test('backupFile copies and preserves mode; returns null when absent', async () => {
  const d = await tmp()
  const f = join(d, 'auth.json')
  await writeFile(f, '{"a":1}')
  await chmod(f, 0o600)
  const b = await backupFile(f)
  assert.equal(b, f + '.bak')
  assert.equal(await readFile(b, 'utf8'), '{"a":1}')
  assert.equal((await stat(b)).mode & 0o777, 0o600)
  assert.equal(await backupFile(join(d, 'nope.json')), null)
})

test('stripJsonComments removes line and block comments', () => {
  assert.equal(stripJsonComments('{"a":1} // trailing'), '{"a":1} ')
  assert.equal(stripJsonComments('{/* hi */"a":1}'), '{"a":1}')
})

test('stripJsonComments does not strip // inside a string', () => {
  const src = '{"$schema":"https://opencode.ai/config.json"}'
  assert.equal(stripJsonComments(src), src)
})

test('readJsonc parses a commented config and returns null when absent', async () => {
  const d = await tmp()
  const f = join(d, 'opencode.jsonc')
  await writeFile(f, '{\n  // the model\n  "model": "openrouter/x"\n}')
  assert.deepEqual(await readJsonc(f), { model: 'openrouter/x' })
  assert.equal(await readJsonc(join(d, 'nope.jsonc')), null)
})

test('mergeWriteJson preserves sibling keys', async () => {
  const d = await tmp()
  const f = join(d, 'auth.json')
  await writeFile(f, JSON.stringify({ openrouter: { type: 'api', key: 'KEEP' } }))
  await mergeWriteJson(f, { anthropic: { type: 'api', key: 'NEW' } }, { mode: 0o600 })
  const out = JSON.parse(await readFile(f, 'utf8'))
  assert.deepEqual(out.openrouter, { type: 'api', key: 'KEEP' })
  assert.deepEqual(out.anthropic, { type: 'api', key: 'NEW' })
  assert.equal((await stat(f)).mode & 0o777, 0o600)
})

test('mergeWriteJson backs up before writing', async () => {
  const d = await tmp()
  const f = join(d, 'auth.json')
  await writeFile(f, JSON.stringify({ a: 1 }))
  const res = await mergeWriteJson(f, { b: 2 })
  assert.equal(res.backup, f + '.bak')
  assert.equal(res.created, false)
  assert.deepEqual(JSON.parse(await readFile(f + '.bak', 'utf8')), { a: 1 })
})

test('mergeWriteJson creates the file with $schema and reports created', async () => {
  const d = await tmp()
  const f = join(d, 'opencode.json')
  const res = await mergeWriteJson(f, { model: 'openrouter/x' }, { schemaUrl: 'https://opencode.ai/config.json' })
  assert.equal(res.created, true)
  assert.equal(res.backup, null)
  const out = JSON.parse(await readFile(f, 'utf8'))
  assert.equal(out.$schema, 'https://opencode.ai/config.json')
  assert.equal(out.model, 'openrouter/x')
})

test('mergeWriteJson does not add $schema to an existing file that lacks it', async () => {
  const d = await tmp()
  const f = join(d, 'opencode.json')
  await writeFile(f, JSON.stringify({ model: 'a/b' }))
  await mergeWriteJson(f, { model: 'c/d' }, { schemaUrl: 'https://opencode.ai/config.json' })
  const out = JSON.parse(await readFile(f, 'utf8'))
  assert.equal(out.$schema, undefined)
  assert.equal(out.model, 'c/d')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/fs.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/lib/fs.mjs'`

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/fs.mjs`:

```js
import { readFile, writeFile, rename, stat, chmod, copyFile, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

let counter = 0

export async function atomicWrite(path, contents, { mode = 0o644 } = {}) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${counter++}`
  try {
    await writeFile(tmp, contents, { mode })
    await chmod(tmp, mode)
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

export async function backupFile(path) {
  let mode
  try {
    mode = (await stat(path)).mode & 0o777
  } catch {
    return null
  }
  const bak = `${path}.bak`
  await copyFile(path, bak)
  await chmod(bak, mode)
  return bak
}

export function stripJsonComments(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    out += ch
  }
  return out
}

export async function readJsonc(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  return JSON.parse(stripJsonComments(text))
}

export async function mergeWriteJson(path, patch, { mode = 0o644, schemaUrl } = {}) {
  const existing = await readJsonc(path)
  const created = existing === null
  const backup = created ? null : await backupFile(path)
  const merged = created && schemaUrl
    ? { $schema: schemaUrl, ...patch }
    : { ...(existing ?? {}), ...patch }
  await atomicWrite(path, JSON.stringify(merged, null, 2) + '\n', { mode })
  return { backup, created }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/fs.test.mjs`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fs.mjs tests/unit/fs.test.mjs
git commit -m "feat: atomic write, backup, JSONC read, and merge-write helpers"
```

---

## Task 3: `lib/state.mjs` — state dir layout and atomic records

**Files:**
- Create: `scripts/lib/state.mjs`
- Test: `tests/unit/state.test.mjs`

**Interfaces:**
- Consumes: `atomicWrite` from `lib/fs.mjs`.
- Produces:
  - `stateRoot(env = process.env): string` — `${XDG_STATE_HOME||$HOME/.local/state}/opencode-plugin-cc`
  - `jobsDir(env?)`, `brokerDir(env?)`, `sessionsDir(env?)`: string
  - `jobDir(jobId, env?): string` — `<jobsDir>/<jobId>`
  - `readJson(path, fallback = null): Promise<any>` — returns `fallback` on ENOENT or malformed JSON
  - `writeJson(path, value): Promise<void>` — atomic, `0o644`
  - `appendJsonl(path, obj): Promise<void>` — appends one JSON line, creating parents
  - `readJsonl(path): Promise<object[]>` — skips unparseable lines rather than throwing
  - `ensureDir(path): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/state.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stateRoot, jobsDir, jobDir, readJson, writeJson, appendJsonl, readJsonl } from '../../scripts/lib/state.mjs'

test('stateRoot honours XDG_STATE_HOME then falls back to ~/.local/state', () => {
  assert.equal(stateRoot({ XDG_STATE_HOME: '/x' }), '/x/opencode-plugin-cc')
  assert.equal(stateRoot({ HOME: '/h' }), '/h/.local/state/opencode-plugin-cc')
})

test('jobDir nests under jobs/', () => {
  const env = { XDG_STATE_HOME: '/x' }
  assert.equal(jobsDir(env), '/x/opencode-plugin-cc/jobs')
  assert.equal(jobDir('job_1', env), '/x/opencode-plugin-cc/jobs/job_1')
})

test('writeJson then readJson round-trips', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ocstate-'))
  const f = join(d, 'nested', 'meta.json')
  await writeJson(f, { a: 1 })
  assert.deepEqual(await readJson(f), { a: 1 })
})

test('readJson returns the fallback for a missing or corrupt file', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ocstate-'))
  assert.deepEqual(await readJson(join(d, 'nope.json'), { d: true }), { d: true })
  const bad = join(d, 'bad.json')
  await appendFile(bad, '{not json')
  assert.deepEqual(await readJson(bad, { d: true }), { d: true })
})

test('appendJsonl appends and readJsonl skips corrupt lines', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ocstate-'))
  const f = join(d, 'events.jsonl')
  await appendJsonl(f, { n: 1 })
  await appendJsonl(f, { n: 2 })
  await appendFile(f, 'garbage\n')
  await appendJsonl(f, { n: 3 })
  assert.deepEqual(await readJsonl(f), [{ n: 1 }, { n: 2 }, { n: 3 }])
})

test('readJsonl returns [] for a missing file', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ocstate-'))
  assert.deepEqual(await readJsonl(join(d, 'nope.jsonl')), [])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/state.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/lib/state.mjs'`

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/state.mjs`:

```js
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { atomicWrite } from './fs.mjs'

export function stateRoot(env = process.env) {
  const base = env.XDG_STATE_HOME || join(env.HOME || '', '.local', 'state')
  return join(base, 'opencode-plugin-cc')
}

export const jobsDir = (env = process.env) => join(stateRoot(env), 'jobs')
export const brokerDir = (env = process.env) => join(stateRoot(env), 'broker')
export const sessionsDir = (env = process.env) => join(stateRoot(env), 'sessions')
export const jobDir = (jobId, env = process.env) => join(jobsDir(env), jobId)

export async function ensureDir(path) {
  await mkdir(path, { recursive: true })
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

export async function writeJson(path, value) {
  await atomicWrite(path, JSON.stringify(value, null, 2) + '\n')
}

export async function appendJsonl(path, obj) {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(obj) + '\n')
}

export async function readJsonl(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A torn write or external garbage must not lose the surrounding events.
    }
  }
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/state.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/state.mjs tests/unit/state.test.mjs
git commit -m "feat: state directory layout with atomic JSON and JSONL records"
```

---

## Task 4: `lib/opencode.mjs` and `lib/args.mjs` — binary resolution, flag mapping, argv parsing

**Files:**
- Create: `scripts/lib/opencode.mjs`, `scripts/lib/args.mjs`
- Test: `tests/unit/opencode.test.mjs`, `tests/unit/args.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MIN_VERSION = '1.18.0'`
  - `resolveBinary({env = process.env} = {}): Promise<{path: string, source: string}>` — probes in order `OPENCODE_BIN`, PATH, `~/.opencode/bin/opencode`, `~/.local/bin/opencode`, `/opt/homebrew/bin/opencode`, `/usr/local/bin/opencode`, `~/.bun/bin/opencode`; `source` is one of `env`, `path`, `home`, `local-bin`, `homebrew`, `usr-local`, `bun`. Throws `Error` with message `opencode binary not found` when none is executable. Result is cached per `env.OPENCODE_BIN + env.PATH + env.HOME` key; `clearBinaryCache()` resets it for tests.
  - `compareVersions(a: string, b: string): -1|0|1`
  - `meetsFloor(version: string): boolean`
  - `buildServeArgs({port = 0, hostname = '127.0.0.1'} = {}): string[]`
  - `buildRunArgs(opts): string[]` — maps `{model, variant, effort, agent, session, continue: boolean, fork, dir, auto, pure, format, title}` to opencode flags. `effort` is an accepted alias for `variant`; `variant` wins if both are given. `auto` defaults to `true`. Never emits `-m`/`--variant` when unset.
- Produces (`args.mjs`):
  - `parseArgs(argv: string[]): {verb: string|null, flags: Record<string, string|boolean>, positional: string[]}` — supports `--flag`, `--flag value`, `--flag=value`, `--no-flag` → `false`, short `-m value`, and `--` terminator putting the rest in `positional`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/args.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../../scripts/lib/args.mjs'

test('parses the verb and leaves flags empty', () => {
  assert.deepEqual(parseArgs(['doctor']), { verb: 'doctor', flags: {}, positional: [] })
})

test('boolean flags, valued flags, equals form, and negation', () => {
  const r = parseArgs(['review', '--background', '--base', 'main', '--scope=branch', '--no-auto'])
  assert.equal(r.verb, 'review')
  assert.deepEqual(r.flags, { background: true, base: 'main', scope: 'branch', auto: false })
})

test('short flags take a value', () => {
  assert.deepEqual(parseArgs(['task', '-m', 'openrouter/x']).flags, { m: 'openrouter/x' })
})

test('everything after -- is positional', () => {
  const r = parseArgs(['task', '--background', '--', 'fix', '--the', 'bug'])
  assert.deepEqual(r.positional, ['fix', '--the', 'bug'])
  assert.deepEqual(r.flags, { background: true })
})

test('bare words after the verb are positional', () => {
  assert.deepEqual(parseArgs(['result', 'job_123']).positional, ['job_123'])
})

test('empty argv yields a null verb', () => {
  assert.equal(parseArgs([]).verb, null)
})
```

Create `tests/unit/opencode.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MIN_VERSION, compareVersions, meetsFloor, resolveBinary, clearBinaryCache,
  buildRunArgs, buildServeArgs
} from '../../scripts/lib/opencode.mjs'

async function fakeBin(dir, name = 'opencode') {
  const p = join(dir, name)
  await writeFile(p, '#!/bin/sh\necho 1.18.11\n')
  await chmod(p, 0o755)
  return p
}

test('compareVersions orders correctly', () => {
  assert.equal(compareVersions('1.18.11', '1.18.2'), 1)
  assert.equal(compareVersions('1.18.0', '1.18.0'), 0)
  assert.equal(compareVersions('1.9.0', '1.18.0'), -1)
})

test('meetsFloor uses MIN_VERSION', () => {
  assert.equal(MIN_VERSION, '1.18.0')
  assert.equal(meetsFloor('1.18.11'), true)
  assert.equal(meetsFloor('1.17.9'), false)
})

test('OPENCODE_BIN wins over everything', async () => {
  clearBinaryCache()
  const d = await mkdtemp(join(tmpdir(), 'ocbin-'))
  const p = await fakeBin(d)
  const r = await resolveBinary({ env: { OPENCODE_BIN: p, PATH: '', HOME: '/nonexistent' } })
  assert.deepEqual(r, { path: p, source: 'env' })
})

test('PATH is used when OPENCODE_BIN is unset', async () => {
  clearBinaryCache()
  const d = await mkdtemp(join(tmpdir(), 'ocbin-'))
  const p = await fakeBin(d)
  const r = await resolveBinary({ env: { PATH: d, HOME: '/nonexistent' } })
  assert.deepEqual(r, { path: p, source: 'path' })
})

test('~/.opencode/bin is used when PATH misses', async () => {
  clearBinaryCache()
  const home = await mkdtemp(join(tmpdir(), 'ochome-'))
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(home, '.opencode', 'bin'), { recursive: true })
  const p = await fakeBin(join(home, '.opencode', 'bin'))
  const r = await resolveBinary({ env: { PATH: '/nonexistent', HOME: home } })
  assert.deepEqual(r, { path: p, source: 'home' })
})

test('missing binary throws a named error', async () => {
  clearBinaryCache()
  await assert.rejects(
    () => resolveBinary({ env: { PATH: '/nonexistent', HOME: '/nonexistent' } }),
    /opencode binary not found/
  )
})

test('buildServeArgs defaults to an ephemeral loopback port', () => {
  assert.deepEqual(buildServeArgs(), ['serve', '--port', '0', '--hostname', '127.0.0.1'])
})

test('buildRunArgs emits --auto and --dir by default and nothing optional', () => {
  assert.deepEqual(buildRunArgs({ dir: '/repo' }), ['run', '--dir', '/repo', '--auto'])
})

test('buildRunArgs maps model, variant, agent, session, fork, pure', () => {
  const a = buildRunArgs({
    dir: '/repo', model: 'openrouter/x', variant: 'high', agent: 'opencode-review',
    session: 'ses_1', fork: true, pure: true
  })
  assert.deepEqual(a, [
    'run', '--dir', '/repo', '--auto', '--pure',
    '-m', 'openrouter/x', '--variant', 'high', '--agent', 'opencode-review',
    '--session', 'ses_1', '--fork'
  ])
})

test('buildRunArgs accepts --effort as an alias for --variant, variant wins', () => {
  assert.deepEqual(buildRunArgs({ dir: '/r', effort: 'high' }), ['run', '--dir', '/r', '--auto', '--variant', 'high'])
  assert.deepEqual(buildRunArgs({ dir: '/r', effort: 'low', variant: 'max' }), ['run', '--dir', '/r', '--auto', '--variant', 'max'])
})

test('buildRunArgs can disable auto', () => {
  assert.deepEqual(buildRunArgs({ dir: '/r', auto: false }), ['run', '--dir', '/r'])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/args.test.mjs tests/unit/opencode.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/lib/args.mjs'`

- [ ] **Step 3: Write `scripts/lib/args.mjs`**

```js
export function parseArgs(argv) {
  const flags = {}
  const positional = []
  let verb = null
  let i = 0
  if (argv[i] && !argv[i].startsWith('-')) verb = argv[i++]
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { positional.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const body = a.slice(2)
      const eq = body.indexOf('=')
      if (eq !== -1) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue }
      if (body.startsWith('no-')) { flags[body.slice(3)] = false; continue }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) { flags[body] = next; i++ }
      else flags[body] = true
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      const key = a.slice(1)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) { flags[key] = next; i++ }
      else flags[key] = true
      continue
    }
    positional.push(a)
  }
  return { verb, flags, positional }
}
```

- [ ] **Step 4: Write `scripts/lib/opencode.mjs`**

```js
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const MIN_VERSION = '1.18.0'

const cache = new Map()
export function clearBinaryCache() { cache.clear() }

async function isExecutable(p) {
  try { await access(p, constants.X_OK); return true } catch { return false }
}

function candidates(env) {
  const home = env.HOME || ''
  const out = []
  if (env.OPENCODE_BIN) out.push({ path: env.OPENCODE_BIN, source: 'env' })
  for (const dir of (env.PATH || '').split(':').filter(Boolean)) {
    out.push({ path: join(dir, 'opencode'), source: 'path' })
  }
  if (home) {
    out.push({ path: join(home, '.opencode', 'bin', 'opencode'), source: 'home' })
    out.push({ path: join(home, '.local', 'bin', 'opencode'), source: 'local-bin' })
  }
  out.push({ path: '/opt/homebrew/bin/opencode', source: 'homebrew' })
  out.push({ path: '/usr/local/bin/opencode', source: 'usr-local' })
  if (home) out.push({ path: join(home, '.bun', 'bin', 'opencode'), source: 'bun' })
  return out
}

export async function resolveBinary({ env = process.env } = {}) {
  const key = `${env.OPENCODE_BIN || ''}|${env.PATH || ''}|${env.HOME || ''}`
  if (cache.has(key)) return cache.get(key)
  for (const c of candidates(env)) {
    if (await isExecutable(c.path)) { cache.set(key, c); return c }
  }
  throw new Error(
    'opencode binary not found. Checked $OPENCODE_BIN, PATH, ~/.opencode/bin, ~/.local/bin, ' +
    '/opt/homebrew/bin, /usr/local/bin, ~/.bun/bin. Run /opencode:setup.'
  )
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

export const meetsFloor = (version) => compareVersions(version, MIN_VERSION) >= 0

export async function binaryVersion(binPath) {
  const { stdout } = await execFileAsync(binPath, ['--version'], { timeout: 20000 })
  const m = stdout.match(/(\d+\.\d+\.\d+)/)
  if (!m) throw new Error(`could not parse opencode version from: ${stdout.trim()}`)
  return m[1]
}

export function buildServeArgs({ port = 0, hostname = '127.0.0.1' } = {}) {
  return ['serve', '--port', String(port), '--hostname', hostname]
}

export function buildRunArgs(opts = {}) {
  const args = ['run']
  if (opts.dir) args.push('--dir', opts.dir)
  if (opts.auto !== false) args.push('--auto')
  if (opts.pure) args.push('--pure')
  if (opts.model) args.push('-m', opts.model)
  const variant = opts.variant ?? opts.effort
  if (variant) args.push('--variant', variant)
  if (opts.agent) args.push('--agent', opts.agent)
  if (opts.session) args.push('--session', opts.session)
  else if (opts.continue) args.push('--continue')
  if (opts.fork) args.push('--fork')
  if (opts.format) args.push('--format', opts.format)
  if (opts.title) args.push('--title', opts.title)
  return args
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/unit/args.test.mjs tests/unit/opencode.test.mjs`
Expected: PASS, 18 tests

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/opencode.mjs scripts/lib/args.mjs tests/unit/opencode.test.mjs tests/unit/args.test.mjs
git commit -m "feat: opencode binary resolution, flag mapping, and argv parsing"
```

---

## Task 5: `lib/credentials.mjs` and `lib/config.mjs` — auth and model, read and write

The credential and config writers are the highest-risk code in the plugin: a bad
merge silently destroys the user's other providers. Test the writers hardest.

**Files:**
- Create: `scripts/lib/credentials.mjs`, `scripts/lib/config.mjs`
- Test: `tests/unit/credentials.test.mjs`, `tests/unit/config.test.mjs`

**Interfaces:**
- Consumes: `mergeWriteJson`, `readJsonc`, `backupFile` from `lib/fs.mjs`.
- Produces (`credentials.mjs`):
  - `authFilePath(env = process.env): string` — `${XDG_DATA_HOME||$HOME/.local/share}/opencode/auth.json`
  - `readAuth(env?): Promise<Record<string, {type: string, key?: string}>>` — `{}` when absent
  - `listProviders(env?): Promise<string[]>` — sorted keys of `readAuth`
  - `envProviderHints(env?): Promise<Array<{provider: string, envVar: string}>>` — detects `ANTHROPIC_API_KEY`→`anthropic`, `OPENAI_API_KEY`→`openai`, `OPENROUTER_API_KEY`→`openrouter`, `GEMINI_API_KEY`→`google`, `GROQ_API_KEY`→`groq`, `DEEPSEEK_API_KEY`→`deepseek`
  - `setKey({provider, key, env?}): Promise<{provider: string, redacted: string, backup: string|null, created: boolean, path: string}>` — merges one provider entry `{type: 'api', key}` into `auth.json`, atomic, mode `0600`, backup first. `redacted` is `****` + last 4 chars. Throws on an empty provider or key.
- Produces (`config.mjs`):
  - `CONFIG_SCHEMA_URL = 'https://opencode.ai/config.json'`
  - `configCandidates({env?, cwd?}): {project: string[], global: string[]}` — each list is `[<dir>/opencode.json, <dir>/opencode.jsonc]`
  - `resolveDefaultModel({env?, cwd?}): Promise<{model: string, source: 'project'|'global', path: string}|null>` — project beats global; within a scope, `.json` beats `.jsonc`
  - `configTargetPath({scope, env?, cwd?}): Promise<string>` — returns the existing file for that scope if one exists (preserving its extension), else `<dir>/opencode.json`
  - `setModel({model, scope, env?, cwd?}): Promise<{path: string, backup: string|null, created: boolean}>` — merge-writes `{model}` into the target, adding `$schema` only when creating

- [ ] **Step 1: Write the failing credential tests**

Create `tests/unit/credentials.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authFilePath, readAuth, listProviders, envProviderHints, setKey } from '../../scripts/lib/credentials.mjs'

async function home() {
  const d = await mkdtemp(join(tmpdir(), 'ocauth-'))
  return { HOME: d, XDG_DATA_HOME: join(d, '.local', 'share') }
}

test('authFilePath honours XDG_DATA_HOME then HOME', () => {
  assert.equal(authFilePath({ XDG_DATA_HOME: '/d' }), '/d/opencode/auth.json')
  assert.equal(authFilePath({ HOME: '/h' }), '/h/.local/share/opencode/auth.json')
})

test('readAuth returns {} when the file is absent', async () => {
  assert.deepEqual(await readAuth(await home()), {})
})

test('listProviders returns sorted provider names', async () => {
  const env = await home()
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await writeFile(authFilePath(env), JSON.stringify({ openrouter: { type: 'api' }, anthropic: { type: 'api' } }))
  assert.deepEqual(await listProviders(env), ['anthropic', 'openrouter'])
})

test('envProviderHints detects keys already in the environment', async () => {
  const env = { ...(await home()), ANTHROPIC_API_KEY: 'x', GROQ_API_KEY: 'y' }
  const hints = await envProviderHints(env)
  assert.deepEqual(hints.map(h => h.provider).sort(), ['anthropic', 'groq'])
})

test('setKey preserves other providers and writes 0600', async () => {
  const env = await home()
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  const p = authFilePath(env)
  await writeFile(p, JSON.stringify({ openrouter: { type: 'api', key: 'KEEP' } }), { mode: 0o600 })
  const res = await setKey({ provider: 'anthropic', key: 'sk-ant-abcd1234', env })
  const out = JSON.parse(await readFile(p, 'utf8'))
  assert.equal(out.openrouter.key, 'KEEP')
  assert.deepEqual(out.anthropic, { type: 'api', key: 'sk-ant-abcd1234' })
  assert.equal((await stat(p)).mode & 0o777, 0o600)
  assert.equal(res.redacted, '****1234')
  assert.equal(res.backup, p + '.bak')
})

test('setKey creates auth.json at 0600 when absent', async () => {
  const env = await home()
  const res = await setKey({ provider: 'openrouter', key: 'sk-or-wxyz9876', env })
  assert.equal(res.created, true)
  assert.equal((await stat(authFilePath(env))).mode & 0o777, 0o600)
})

test('setKey rejects an empty provider or key', async () => {
  const env = await home()
  await assert.rejects(() => setKey({ provider: '', key: 'k', env }), /provider/)
  await assert.rejects(() => setKey({ provider: 'p', key: '', env }), /key/)
})

test('setKey never returns the raw key', async () => {
  const env = await home()
  const res = await setKey({ provider: 'openrouter', key: 'sk-or-secret-tail', env })
  assert.equal(JSON.stringify(res).includes('secret'), false)
})
```

- [ ] **Step 2: Write the failing config tests**

Create `tests/unit/config.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_SCHEMA_URL, resolveDefaultModel, configTargetPath, setModel } from '../../scripts/lib/config.mjs'

async function sandbox() {
  const d = await mkdtemp(join(tmpdir(), 'occfg-'))
  const cwd = join(d, 'repo')
  const cfg = join(d, '.config')
  await mkdir(cwd, { recursive: true })
  await mkdir(join(cfg, 'opencode'), { recursive: true })
  return { cwd, env: { HOME: d, XDG_CONFIG_HOME: cfg }, globalDir: join(cfg, 'opencode') }
}

test('resolveDefaultModel returns null when nothing is configured', async () => {
  const s = await sandbox()
  assert.equal(await resolveDefaultModel({ env: s.env, cwd: s.cwd }), null)
})

test('resolveDefaultModel reads a global opencode.jsonc with comments', async () => {
  const s = await sandbox()
  await writeFile(join(s.globalDir, 'opencode.jsonc'),
    '{\n  // chosen by setup\n  "$schema": "https://opencode.ai/config.json",\n  "model": "openrouter/deepseek/deepseek-v4-flash-0731"\n}')
  const r = await resolveDefaultModel({ env: s.env, cwd: s.cwd })
  assert.equal(r.model, 'openrouter/deepseek/deepseek-v4-flash-0731')
  assert.equal(r.source, 'global')
})

test('project config beats global', async () => {
  const s = await sandbox()
  await writeFile(join(s.globalDir, 'opencode.jsonc'), '{"model":"global/m"}')
  await writeFile(join(s.cwd, 'opencode.json'), '{"model":"project/m"}')
  const r = await resolveDefaultModel({ env: s.env, cwd: s.cwd })
  assert.equal(r.model, 'project/m')
  assert.equal(r.source, 'project')
})

test('configTargetPath reuses an existing .jsonc rather than creating a second file', async () => {
  const s = await sandbox()
  await writeFile(join(s.globalDir, 'opencode.jsonc'), '{"model":"a/b"}')
  assert.equal(await configTargetPath({ scope: 'global', env: s.env, cwd: s.cwd }), join(s.globalDir, 'opencode.jsonc'))
})

test('configTargetPath defaults to opencode.json when nothing exists', async () => {
  const s = await sandbox()
  assert.equal(await configTargetPath({ scope: 'project', env: s.env, cwd: s.cwd }), join(s.cwd, 'opencode.json'))
})

test('setModel merges into an existing .jsonc and preserves siblings', async () => {
  const s = await sandbox()
  const f = join(s.globalDir, 'opencode.jsonc')
  await writeFile(f, '{\n  // keep me\n  "theme": "dark",\n  "model": "old/m"\n}')
  const res = await setModel({ model: 'new/m', scope: 'global', env: s.env, cwd: s.cwd })
  assert.equal(res.path, f)
  const out = JSON.parse(await readFile(f, 'utf8'))
  assert.equal(out.theme, 'dark')
  assert.equal(out.model, 'new/m')
  assert.equal(res.backup, f + '.bak')
})

test('setModel creates a new config with $schema', async () => {
  const s = await sandbox()
  const res = await setModel({ model: 'openrouter/x', scope: 'project', env: s.env, cwd: s.cwd })
  assert.equal(res.created, true)
  const out = JSON.parse(await readFile(res.path, 'utf8'))
  assert.equal(out.$schema, CONFIG_SCHEMA_URL)
  assert.equal(out.model, 'openrouter/x')
})
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `node --test tests/unit/credentials.test.mjs tests/unit/config.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/lib/credentials.mjs'`

- [ ] **Step 4: Write `scripts/lib/credentials.mjs`**

```js
import { join } from 'node:path'
import { readJsonc, mergeWriteJson } from './fs.mjs'

const ENV_HINTS = [
  ['ANTHROPIC_API_KEY', 'anthropic'],
  ['OPENAI_API_KEY', 'openai'],
  ['OPENROUTER_API_KEY', 'openrouter'],
  ['GEMINI_API_KEY', 'google'],
  ['GROQ_API_KEY', 'groq'],
  ['DEEPSEEK_API_KEY', 'deepseek'],
]

export function authFilePath(env = process.env) {
  const base = env.XDG_DATA_HOME || join(env.HOME || '', '.local', 'share')
  return join(base, 'opencode', 'auth.json')
}

export async function readAuth(env = process.env) {
  return (await readJsonc(authFilePath(env))) ?? {}
}

export async function listProviders(env = process.env) {
  return Object.keys(await readAuth(env)).sort()
}

export async function envProviderHints(env = process.env) {
  return ENV_HINTS.filter(([v]) => env[v]).map(([envVar, provider]) => ({ provider, envVar }))
}

function redact(key) {
  return '****' + String(key).slice(-4)
}

export async function setKey({ provider, key, env = process.env }) {
  if (!provider || !String(provider).trim()) throw new Error('set-key requires a non-empty --provider')
  if (!key || !String(key).trim()) throw new Error('set-key requires a non-empty --key')
  const path = authFilePath(env)
  const { backup, created } = await mergeWriteJson(
    path,
    { [provider]: { type: 'api', key } },
    { mode: 0o600 }
  )
  return { provider, redacted: redact(key), backup, created, path }
}
```

- [ ] **Step 5: Write `scripts/lib/config.mjs`**

```js
import { join } from 'node:path'
import { access } from 'node:fs/promises'
import { readJsonc, mergeWriteJson } from './fs.mjs'

export const CONFIG_SCHEMA_URL = 'https://opencode.ai/config.json'

const exists = async (p) => { try { await access(p); return true } catch { return false } }

function globalDir(env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || '', '.config')
  return join(base, 'opencode')
}

export function configCandidates({ env = process.env, cwd = process.cwd() } = {}) {
  const names = ['opencode.json', 'opencode.jsonc']
  return {
    project: names.map(n => join(cwd, n)),
    global: names.map(n => join(globalDir(env), n)),
  }
}

export async function resolveDefaultModel({ env = process.env, cwd = process.cwd() } = {}) {
  const c = configCandidates({ env, cwd })
  for (const source of ['project', 'global']) {
    for (const path of c[source]) {
      const cfg = await readJsonc(path).catch(() => null)
      if (cfg && typeof cfg.model === 'string' && cfg.model) return { model: cfg.model, source, path }
    }
  }
  return null
}

export async function configTargetPath({ scope, env = process.env, cwd = process.cwd() } = {}) {
  if (scope !== 'project' && scope !== 'global') throw new Error(`scope must be project or global, got: ${scope}`)
  const list = configCandidates({ env, cwd })[scope]
  for (const p of list) if (await exists(p)) return p
  return list[0]
}

export async function setModel({ model, scope, env = process.env, cwd = process.cwd() }) {
  if (!model || !String(model).includes('/')) {
    throw new Error(`model must be in provider/model form, got: ${model}`)
  }
  const path = await configTargetPath({ scope, env, cwd })
  const { backup, created } = await mergeWriteJson(path, { model }, { schemaUrl: CONFIG_SCHEMA_URL })
  return { path, backup, created }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/unit/credentials.test.mjs tests/unit/config.test.mjs`
Expected: PASS, 15 tests

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/credentials.mjs scripts/lib/config.mjs tests/unit/credentials.test.mjs tests/unit/config.test.mjs
git commit -m "feat: auth.json and opencode config readers plus safe set-key/set-model writers"
```

---

## Task 6: `lib/process.mjs` and the fake opencode fixture

The fixture impersonates the binary so every later task can be tested without
spending tokens. It must be built before the server client.

**Files:**
- Create: `scripts/lib/process.mjs`, `tests/fake-opencode-fixture.mjs`, `tests/fixture-bin/opencode` (shim)
- Test: `tests/unit/process.test.mjs`, `tests/unit/fixture.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (`process.mjs`):
  - `run(cmd, args, {cwd?, env?, timeoutMs = 120000, input?}): Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean}>` — never throws on a non-zero exit; kills with SIGTERM on timeout and sets `timedOut: true`
  - `spawnDetached(cmd, args, {cwd?, env?, stdio?}): ChildProcess` — `detached: true`, `unref()`ed
  - `terminate(pid, {graceMs = 3000}): Promise<'exited'|'killed'|'gone'>` — SIGTERM, poll, then SIGKILL
  - `isAlive(pid): boolean`
- Produces (fixture): an executable at `tests/fixture-bin/opencode` that dispatches to `tests/fake-opencode-fixture.mjs`, implementing:
  - `--version` → prints `$FAKE_OPENCODE_VERSION` or `1.18.11`
  - `auth list` → prints a TUI-ish box listing providers from the fixture's `auth.json`
  - `models` → prints one `provider/model` per line from `$FAKE_OPENCODE_MODELS` (comma-separated) or a three-line default
  - `serve --port <n> --hostname <h>` → stands up a real `node:http` server implementing `GET /doc`, `POST /session`, `POST /session/:id/prompt_async`, `GET /global/event` (SSE), `POST /session/:id/abort`; prints `opencode server listening on http://<h>:<port>` to stdout
  - Fault modes via env: `FAKE_OPENCODE_FAULT` ∈ `missing-binary` (exit 127), `old-version` (prints `1.17.0`), `slow-start` (sleeps `FAKE_OPENCODE_START_DELAY_MS` before listening), `sse-disconnect` (drops the SSE socket mid-stream), `malformed-json` (emits an unparseable assistant text), `nonzero-exit` (exit 3), `port-bound` (fails to bind)
  - Scripted event replay via `FAKE_OPENCODE_SCRIPT` — a path to a JSONL file of event payloads emitted in order on `prompt_async`; default script emits `session.next.step.started`, one `session.next.tool.called`, `session.next.text.delta` chunks, `message.updated` with token counts, then `session.idle`

- [ ] **Step 1: Write the failing process tests**

Create `tests/unit/process.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run, spawnDetached, terminate, isAlive } from '../../scripts/lib/process.mjs'

test('run captures stdout and a zero exit', async () => {
  const r = await run('node', ['-e', 'console.log("hi")'])
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), 'hi')
  assert.equal(r.timedOut, false)
})

test('run reports a non-zero exit without throwing', async () => {
  const r = await run('node', ['-e', 'console.error("bad"); process.exit(3)'])
  assert.equal(r.code, 3)
  assert.match(r.stderr, /bad/)
})

test('run times out and reports timedOut', async () => {
  const r = await run('node', ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 300 })
  assert.equal(r.timedOut, true)
})

test('run writes input to stdin', async () => {
  const r = await run('node', ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'ping' })
  assert.equal(r.stdout, 'ping')
})

test('terminate stops a detached child and isAlive goes false', async () => {
  const child = spawnDetached('node', ['-e', 'setInterval(()=>{}, 1000)'])
  assert.equal(isAlive(child.pid), true)
  const outcome = await terminate(child.pid, { graceMs: 2000 })
  assert.ok(['exited', 'killed'].includes(outcome))
  assert.equal(isAlive(child.pid), false)
})

test('terminate reports gone for an unknown pid', async () => {
  assert.equal(await terminate(2 ** 22, { graceMs: 100 }), 'gone')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/process.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/lib/process.mjs'`

- [ ] **Step 3: Write `scripts/lib/process.mjs`**

```js
import { spawn } from 'node:child_process'

export function run(cmd, args, { cwd, env, timeoutMs = 120000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }) })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

export function spawnDetached(cmd, args, { cwd, env, stdio = 'ignore' } = {}) {
  const child = spawn(cmd, args, { cwd, env: env ?? process.env, detached: true, stdio })
  child.unref()
  return child
}

export function isAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function terminate(pid, { graceMs = 3000 } = {}) {
  if (!isAlive(pid)) return 'gone'
  try { process.kill(pid, 'SIGTERM') } catch { return 'gone' }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return 'exited'
    await sleep(50)
  }
  try { process.kill(pid, 'SIGKILL') } catch { return 'exited' }
  await sleep(100)
  return 'killed'
}
```

- [ ] **Step 4: Run the process tests to verify they pass**

Run: `node --test tests/unit/process.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Write the fake fixture**

Create `tests/fake-opencode-fixture.mjs`:

```js
#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const fault = process.env.FAKE_OPENCODE_FAULT || ''
const version = process.env.FAKE_OPENCODE_VERSION || '1.18.11'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const DEFAULT_SCRIPT = [
  { type: 'session.next.step.started', properties: { agent: 'opencode-review', model: { providerID: 'fake', modelID: 'fake-1' } } },
  { type: 'session.next.tool.called', properties: { callID: 'call_1', tool: 'read', input: { path: 'src/a.js' } } },
  { type: 'session.next.text.delta', properties: { textID: 'txt_1', delta: '{"findings":[' } },
  { type: 'session.next.text.delta', properties: { textID: 'txt_1', delta: '{"file":"src/a.js","line":10,"severity":"high","confidence":"high","body":"Null deref."}' } },
  { type: 'session.next.text.delta', properties: { textID: 'txt_1', delta: ']}' } },
  { type: 'message.updated', properties: { info: { role: 'assistant', tokens: { input: 120, output: 45 }, cost: 0.0001 } } },
  { type: 'session.idle', properties: {} },
]

function loadScript() {
  const p = process.env.FAKE_OPENCODE_SCRIPT
  if (!p) return DEFAULT_SCRIPT
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function flag(name, fallback) {
  const i = argv.indexOf(name)
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

if (fault === 'missing-binary') process.exit(127)
if (fault === 'nonzero-exit') { process.stderr.write('fake opencode failed\n'); process.exit(3) }

if (argv.includes('--version')) {
  process.stdout.write((fault === 'old-version' ? '1.17.0' : version) + '\n')
  process.exit(0)
}

if (argv[0] === 'auth' && argv[1] === 'list') {
  const providers = (process.env.FAKE_OPENCODE_PROVIDERS || 'openrouter').split(',').filter(Boolean)
  process.stdout.write('┌  Credentials ~/.local/share/opencode/auth.json\n│\n')
  for (const p of providers) process.stdout.write(`●  ${p} api\n│\n`)
  process.stdout.write(`└  ${providers.length} credentials\n`)
  process.exit(0)
}

if (argv[0] === 'models') {
  const models = (process.env.FAKE_OPENCODE_MODELS || 'fake/model-a,fake/model-b,fake/model-c').split(',')
  process.stdout.write(models.join('\n') + '\n')
  process.exit(0)
}

if (argv[0] === 'serve') {
  if (fault === 'port-bound') { process.stderr.write('EADDRINUSE: address already in use\n'); process.exit(1) }
  const port = Number(flag('--port', '0'))
  const hostname = flag('--hostname', '127.0.0.1')
  const script = loadScript()
  const sessions = new Map()
  const listeners = new Set()

  function broadcast(payload) {
    for (const res of listeners) res.write(`data: ${JSON.stringify({ payload: { id: 'evt_fake', ...payload } })}\n\n`)
  }

  async function replay(sessionID) {
    for (const ev of script) {
      if (sessions.get(sessionID)?.aborted) {
        broadcast({ type: 'session.error', properties: { sessionID, error: { name: 'MessageAbortedError' } } })
        return
      }
      const props = { sessionID, ...ev.properties }
      if (fault === 'malformed-json' && ev.type === 'session.next.text.delta') props.delta = 'not json at all'
      broadcast({ type: ev.type, properties: props })
      if (fault === 'sse-disconnect' && ev.type === 'session.next.tool.called') {
        for (const res of listeners) { res.destroy(); listeners.delete(res) }
      }
      await sleep(Number(process.env.FAKE_OPENCODE_EVENT_DELAY_MS || 5))
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/doc') return send(200, { openapi: '3.0.0', paths: { '/session': {}, '/global/event': {} } })
    if (url.pathname === '/global/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify({ payload: { id: 'evt_fake', type: 'server.connected', properties: {} } })}\n\n`)
      listeners.add(res)
      req.on('close', () => listeners.delete(res))
      return
    }
    if (url.pathname === '/session' && req.method === 'POST') {
      const id = `ses_fake_${sessions.size + 1}`
      sessions.set(id, { aborted: false })
      return send(200, { id, directory: process.cwd(), time: { created: 0, updated: 0 } })
    }
    const m = url.pathname.match(/^\/session\/([^/]+)\/(prompt_async|abort)$/)
    if (m && req.method === 'POST') {
      const [, id, action] = m
      if (!sessions.has(id)) sessions.set(id, { aborted: false })
      if (action === 'abort') { sessions.get(id).aborted = true; return send(200, true) }
      replay(id)
      return send(200, { messageID: 'msg_fake_1' })
    }
    send(404, { error: 'not found' })
  })

  const start = async () => {
    if (fault === 'slow-start') await sleep(Number(process.env.FAKE_OPENCODE_START_DELAY_MS || 3000))
    server.listen(port, hostname, () => {
      process.stdout.write(`opencode server listening on http://${hostname}:${server.address().port}\n`)
    })
  }
  start()
} else {
  process.stderr.write(`fake opencode: unsupported invocation: ${argv.join(' ')}\n`)
  process.exit(2)
}
```

- [ ] **Step 6: Create the PATH shim**

```bash
mkdir -p tests/fixture-bin
cat > tests/fixture-bin/opencode <<'SH'
#!/bin/sh
exec node "$(dirname "$0")/../fake-opencode-fixture.mjs" "$@"
SH
chmod +x tests/fixture-bin/opencode
```

- [ ] **Step 7: Write the fixture test**

Create `tests/unit/fixture.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'

const bin = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))

test('fixture reports a version', async () => {
  const r = await run(bin, ['--version'])
  assert.equal(r.stdout.trim(), '1.18.11')
})

test('fixture honours the old-version fault', async () => {
  const r = await run(bin, ['--version'], { env: { ...process.env, FAKE_OPENCODE_FAULT: 'old-version' } })
  assert.equal(r.stdout.trim(), '1.17.0')
})

test('fixture lists models', async () => {
  const r = await run(bin, ['models'], { env: { ...process.env, FAKE_OPENCODE_MODELS: 'a/b,c/d' } })
  assert.deepEqual(r.stdout.trim().split('\n'), ['a/b', 'c/d'])
})

test('fixture serve answers /doc and prints its port', async () => {
  const { spawnDetached, terminate } = await import('../../scripts/lib/process.mjs')
  const child = spawnDetached(bin, ['serve', '--port', '0', '--hostname', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('fixture never printed a port')), 10000)
    child.stdout.on('data', (d) => {
      const m = String(d).match(/listening on http:\/\/[^:]+:(\d+)/)
      if (m) { clearTimeout(t); resolve(Number(m[1])) }
    })
  })
  const res = await fetch(`http://127.0.0.1:${port}/doc`)
  assert.equal(res.status, 200)
  await terminate(child.pid)
})
```

- [ ] **Step 8: Run the fixture tests to verify they pass**

Run: `node --test tests/unit/fixture.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 9: Commit**

```bash
git add scripts/lib/process.mjs tests/fake-opencode-fixture.mjs tests/fixture-bin/opencode tests/unit/process.test.mjs tests/unit/fixture.test.mjs
git commit -m "feat: process helpers and a fake opencode binary fixture with fault modes"
```

---

## Task 7: `lib/server.mjs` — HTTP + SSE client

Wire shapes here are copied from the live `GET /doc` of opencode 1.18.11. Do not
invent fields.

**Files:**
- Create: `scripts/lib/server.mjs`, `scripts/lib/server-protocol.d.ts`
- Test: `tests/unit/server.test.mjs`

**Interfaces:**
- Consumes: the fixture from Task 6.
- Produces:
  - `class OpencodeClient { constructor(baseUrl: string, opts?: {password?: string, username?: string, fetchImpl?: typeof fetch}) }`
    - `doc(): Promise<object>` — `GET /doc`
    - `health({timeoutMs = 2000}): Promise<boolean>` — `GET /doc`, true on HTTP 200, false on any error
    - `createSession({title?, agent?, model?: {providerID, id, variant?}}): Promise<{id: string}>` — `POST /session`
    - `promptAsync(sessionID, {parts, agent?, model?: {providerID, modelID}, variant?, system?, tools?}): Promise<object>` — `POST /session/:id/prompt_async`
    - `abort(sessionID): Promise<void>` — `POST /session/:id/abort`
    - `events({signal, onEvent}): Promise<void>` — `GET /global/event`, parses `data: {...}` frames, calls `onEvent(payload)` with the **unwrapped** `payload` object (`{id, type, properties}`), resolves when the stream ends or `signal` aborts
  - `class HttpError extends Error { status: number; body: string }`
  - `parseSseChunk(buffer: string): {events: object[], rest: string}` — exported pure function so framing is unit-testable

- [ ] **Step 1: Write the failing test**

Create `tests/unit/server.test.mjs`:

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { spawnDetached, terminate } from '../../scripts/lib/process.mjs'
import { OpencodeClient, parseSseChunk, HttpError } from '../../scripts/lib/server.mjs'

const bin = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))
let child, baseUrl

before(async () => {
  child = spawnDetached(bin, ['serve', '--port', '0', '--hostname', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no port')), 10000)
    child.stdout.on('data', (d) => {
      const m = String(d).match(/listening on http:\/\/[^:]+:(\d+)/)
      if (m) { clearTimeout(t); resolve(Number(m[1])) }
    })
  })
  baseUrl = `http://127.0.0.1:${port}`
})

after(async () => { await terminate(child.pid) })

test('parseSseChunk splits complete frames and keeps the remainder', () => {
  const r = parseSseChunk('data: {"payload":{"type":"a"}}\n\ndata: {"payload":{"typ')
  assert.deepEqual(r.events, [{ payload: { type: 'a' } }])
  assert.equal(r.rest, 'data: {"payload":{"typ')
})

test('parseSseChunk ignores comment and empty frames', () => {
  const r = parseSseChunk(': keepalive\n\ndata: {"payload":{"type":"b"}}\n\n')
  assert.deepEqual(r.events, [{ payload: { type: 'b' } }])
})

test('doc and health succeed against a live fixture server', async () => {
  const c = new OpencodeClient(baseUrl)
  assert.ok((await c.doc()).paths)
  assert.equal(await c.health(), true)
})

test('health is false for a dead endpoint', async () => {
  const c = new OpencodeClient('http://127.0.0.1:1')
  assert.equal(await c.health({ timeoutMs: 500 }), false)
})

test('createSession returns a session id', async () => {
  const c = new OpencodeClient(baseUrl)
  const s = await c.createSession({ title: 'test' })
  assert.match(s.id, /^ses_/)
})

test('promptAsync drives events to session.idle', async () => {
  const c = new OpencodeClient(baseUrl)
  const s = await c.createSession({ title: 'test' })
  const seen = []
  const ac = new AbortController()
  const streaming = c.events({
    signal: ac.signal,
    onEvent: (p) => {
      seen.push(p.type)
      if (p.type === 'session.idle') ac.abort()
    },
  })
  await new Promise((r) => setTimeout(r, 100))
  await c.promptAsync(s.id, { parts: [{ type: 'text', text: 'review this' }] })
  await streaming
  assert.ok(seen.includes('session.next.tool.called'))
  assert.ok(seen.includes('session.idle'))
})

test('a 404 raises HttpError with the status', async () => {
  const c = new OpencodeClient(baseUrl)
  await assert.rejects(() => c.request('GET', '/nope'), (e) => e instanceof HttpError && e.status === 404)
})

test('abort resolves', async () => {
  const c = new OpencodeClient(baseUrl)
  const s = await c.createSession({})
  await c.abort(s.id)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/server.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/lib/server.mjs'`

- [ ] **Step 3: Write `scripts/lib/server.mjs`**

```js
export class HttpError extends Error {
  constructor(status, body, url) {
    super(`HTTP ${status} from ${url}: ${String(body).slice(0, 400)}`)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

export function parseSseChunk(buffer) {
  const events = []
  let rest = buffer
  while (true) {
    const idx = rest.indexOf('\n\n')
    if (idx === -1) break
    const frame = rest.slice(0, idx)
    rest = rest.slice(idx + 2)
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data) continue
      try { events.push(JSON.parse(data)) } catch { /* ignore malformed frames */ }
    }
  }
  return { events, rest }
}

export class OpencodeClient {
  constructor(baseUrl, { password, username = 'opencode', fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.password = password
    this.username = username
    this.fetch = fetchImpl
  }

  headers(extra = {}) {
    const h = { ...extra }
    if (this.password) {
      h.authorization = 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64')
    }
    return h
  }

  async request(method, path, body, { timeoutMs = 60000, signal } = {}) {
    const url = this.baseUrl + path
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true })
    try {
      const res = await this.fetch(url, {
        method,
        signal: ac.signal,
        headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      if (!res.ok) throw new HttpError(res.status, text, url)
      return text ? JSON.parse(text) : null
    } finally {
      clearTimeout(timer)
    }
  }

  doc() { return this.request('GET', '/doc') }

  async health({ timeoutMs = 2000 } = {}) {
    try { await this.request('GET', '/doc', undefined, { timeoutMs }); return true } catch { return false }
  }

  createSession(body = {}) { return this.request('POST', '/session', body) }

  promptAsync(sessionID, body) {
    return this.request('POST', `/session/${encodeURIComponent(sessionID)}/prompt_async`, body)
  }

  async abort(sessionID) {
    await this.request('POST', `/session/${encodeURIComponent(sessionID)}/abort`, {})
  }

  async events({ signal, onEvent }) {
    const res = await this.fetch(this.baseUrl + '/global/event', {
      headers: this.headers({ accept: 'text/event-stream' }),
      signal,
    })
    if (!res.ok) throw new HttpError(res.status, await res.text(), this.baseUrl + '/global/event')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const { events, rest } = parseSseChunk(buffer)
        buffer = rest
        for (const e of events) if (e.payload) onEvent(e.payload)
      }
    } catch (err) {
      if (err.name !== 'AbortError') throw err
    } finally {
      reader.cancel().catch(() => {})
    }
  }
}
```

- [ ] **Step 4: Write `scripts/lib/server-protocol.d.ts`**

Hand-written, documentation-only. Never compiled.

```ts
// Wire types for the opencode HTTP server, transcribed from GET /doc on 1.18.11.
// Documentation only — this file is never compiled or imported at runtime.

export interface SessionCreateRequest {
  title?: string
  agent?: string
  parentID?: string
  model?: { providerID: string; id: string; variant?: string }
  permission?: Record<string, unknown>
}

export interface Session {
  id: string
  directory?: string
  parentID?: string
  title?: string
}

export interface TextPartInput { type: 'text'; text: string }
export interface FilePartInput { type: 'file'; url: string; mime?: string; filename?: string }

export interface PromptAsyncRequest {
  parts: Array<TextPartInput | FilePartInput>
  messageID?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  system?: string
  tools?: Record<string, boolean>
}

export interface EventPayload<T = Record<string, unknown>> {
  id: string
  type: string
  properties: T
}

// Types observed in practice, in the order a job sees them:
export type StepStarted = EventPayload<{ sessionID: string; assistantMessageID: string; agent?: string; model?: { providerID: string; modelID: string } }>
export type ToolCalled = EventPayload<{ sessionID: string; callID: string; tool: string; input?: Record<string, unknown> }>
export type TextDelta = EventPayload<{ sessionID: string; assistantMessageID: string; textID: string; delta?: string }>
export type MessageUpdated = EventPayload<{ sessionID: string; info: { role: string; tokens?: { input?: number; output?: number }; cost?: number } }>
export type SessionIdle = EventPayload<{ sessionID: string }>
export type SessionError = EventPayload<{ sessionID: string; error?: { name?: string; data?: unknown } }>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/unit/server.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/server.mjs scripts/lib/server-protocol.d.ts tests/unit/server.test.mjs
git commit -m "feat: opencode HTTP and SSE client with hand-written wire types"
```

---

## Task 8: The broker — endpoint file, lifecycle, and `scripts/server-broker.mjs`

Spawn-once under concurrent Claude Code windows is the hard part. The lockfile is
an exclusive `open(..., 'wx')`; the loser polls the portfile instead of spawning.

**Files:**
- Create: `scripts/lib/broker-endpoint.mjs`, `scripts/lib/broker-lifecycle.mjs`, `scripts/server-broker.mjs`
- Test: `tests/unit/broker-endpoint.test.mjs`, `tests/integration/broker-lifecycle.test.mjs`

**Interfaces:**
- Consumes: `brokerDir`, `readJson`, `writeJson` (`lib/state.mjs`); `resolveBinary`, `buildServeArgs` (`lib/opencode.mjs`); `spawnDetached`, `terminate`, `isAlive` (`lib/process.mjs`); `OpencodeClient` (`lib/server.mjs`).
- Produces (`broker-endpoint.mjs`):
  - `endpointPath(env?)`, `lockPath(env?)`, `refsPath(env?)`: string — `<brokerDir>/port.json`, `<brokerDir>/lock`, `<brokerDir>/refs.json`
  - `readEndpoint(env?): Promise<{port: number, pid: number, password: string, startedAt: number}|null>`
  - `writeEndpoint(rec, env?): Promise<void>`
  - `clearEndpoint(env?): Promise<void>` — removes portfile and lock, ignoring ENOENT
  - `baseUrlFor(rec): string` — `http://127.0.0.1:<port>`
  - `acquireLock(env?): Promise<boolean>` — `open(lock, 'wx')`; returns false if held. A lock whose recorded pid is dead, or older than 60s, is stale and is removed before retrying once.
  - `releaseLock(env?): Promise<void>`
- Produces (`broker-lifecycle.mjs`):
  - `ensureBroker({env?, timeoutMs = 20000}): Promise<{baseUrl: string, password: string, pid: number, client: OpencodeClient}>`
  - `addRef(ccSessionId, env?): Promise<number>` / `releaseRef(ccSessionId, env?): Promise<{remaining: number, shutdown: boolean}>` — `releaseRef` shuts the broker down when the last ref goes and prunes refs whose Claude Code session is no longer registered
  - `shutdownBroker(env?): Promise<'stopped'|'gone'>`
  - `reapOrphans(env?): Promise<{cleared: boolean}>` — clears a portfile whose pid is dead or whose `/doc` does not answer

- [ ] **Step 1: Write the failing endpoint test**

Create `tests/unit/broker-endpoint.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { endpointPath, lockPath, readEndpoint, writeEndpoint, clearEndpoint, baseUrlFor, acquireLock, releaseLock } from '../../scripts/lib/broker-endpoint.mjs'

const sandbox = async () => ({ XDG_STATE_HOME: await mkdtemp(join(tmpdir(), 'ocbroker-')), HOME: '/nonexistent' })

test('paths live under the broker state dir', async () => {
  const env = { XDG_STATE_HOME: '/s' }
  assert.equal(endpointPath(env), '/s/opencode-plugin-cc/broker/port.json')
  assert.equal(lockPath(env), '/s/opencode-plugin-cc/broker/lock')
})

test('readEndpoint returns null before anything is written', async () => {
  assert.equal(await readEndpoint(await sandbox()), null)
})

test('writeEndpoint then readEndpoint round-trips and baseUrlFor is loopback', async () => {
  const env = await sandbox()
  await writeEndpoint({ port: 4096, pid: 999, password: 'pw', startedAt: 1 }, env)
  const rec = await readEndpoint(env)
  assert.equal(rec.port, 4096)
  assert.equal(baseUrlFor(rec), 'http://127.0.0.1:4096')
})

test('clearEndpoint removes the portfile and is safe twice', async () => {
  const env = await sandbox()
  await writeEndpoint({ port: 1, pid: 2, password: 'p', startedAt: 0 }, env)
  await clearEndpoint(env)
  await clearEndpoint(env)
  assert.equal(await readEndpoint(env), null)
})

test('acquireLock is exclusive and releaseLock frees it', async () => {
  const env = await sandbox()
  assert.equal(await acquireLock(env), true)
  assert.equal(await acquireLock(env), false)
  await releaseLock(env)
  assert.equal(await acquireLock(env), true)
})

test('a lock held by a dead pid is treated as stale', async () => {
  const env = await sandbox()
  await mkdir(join(env.XDG_STATE_HOME, 'opencode-plugin-cc', 'broker'), { recursive: true })
  await writeFile(lockPath(env), JSON.stringify({ pid: 2 ** 22, at: Date.now() }))
  assert.equal(await acquireLock(env), true)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/broker-endpoint.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/lib/broker-endpoint.mjs'`

- [ ] **Step 3: Write `scripts/lib/broker-endpoint.mjs`**

```js
import { open, unlink, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { brokerDir, readJson, writeJson } from './state.mjs'
import { isAlive } from './process.mjs'

const STALE_LOCK_MS = 60_000

export const endpointPath = (env = process.env) => join(brokerDir(env), 'port.json')
export const lockPath = (env = process.env) => join(brokerDir(env), 'lock')
export const refsPath = (env = process.env) => join(brokerDir(env), 'refs.json')

export const baseUrlFor = (rec) => `http://127.0.0.1:${rec.port}`

export async function readEndpoint(env = process.env) {
  return await readJson(endpointPath(env), null)
}

export async function writeEndpoint(rec, env = process.env) {
  await mkdir(brokerDir(env), { recursive: true })
  await writeJson(endpointPath(env), rec)
}

export async function clearEndpoint(env = process.env) {
  await unlink(endpointPath(env)).catch(() => {})
  await unlink(lockPath(env)).catch(() => {})
}

async function lockIsStale(env) {
  try {
    const rec = JSON.parse(await readFile(lockPath(env), 'utf8'))
    if (rec.pid && !isAlive(rec.pid)) return true
    return Date.now() - (rec.at || 0) > STALE_LOCK_MS
  } catch {
    return true
  }
}

export async function acquireLock(env = process.env) {
  await mkdir(brokerDir(env), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(lockPath(env), 'wx')
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
      await fh.close()
      return true
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (attempt === 0 && await lockIsStale(env)) {
        await unlink(lockPath(env)).catch(() => {})
        continue
      }
      return false
    }
  }
  return false
}

export async function releaseLock(env = process.env) {
  await unlink(lockPath(env)).catch(() => {})
}
```

- [ ] **Step 4: Run the endpoint tests to verify they pass**

Run: `node --test tests/unit/broker-endpoint.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Write `scripts/server-broker.mjs`**

The broker child: spawns `opencode serve`, waits for the printed port, writes the
portfile, and stays attached so the server dies with it only if detached spawning
is disabled. Here it execs the server directly and reports the port on stdout so
the parent can record it.

```js
#!/usr/bin/env node
// Spawns `opencode serve` and prints one JSON line: {"port":N,"pid":N}
// Used by broker-lifecycle.ensureBroker. Not a user-facing entrypoint.
import { resolveBinary, buildServeArgs } from './lib/opencode.mjs'
import { spawn } from 'node:child_process'

const password = process.env.OPENCODE_SERVER_PASSWORD || ''
const { path: bin } = await resolveBinary({ env: process.env })
const child = spawn(bin, buildServeArgs({ port: 0, hostname: '127.0.0.1' }), {
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})

let settled = false
const fail = (msg) => {
  if (settled) return
  settled = true
  process.stderr.write(msg)
  process.exit(1)
}

const timer = setTimeout(() => fail('broker: opencode serve did not report a port within 20s\n'), 20_000)

let stderrBuf = ''
child.stderr.on('data', (d) => { stderrBuf += d; if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192) })
child.on('exit', (code) => fail(`broker: opencode serve exited with ${code}\n${stderrBuf}`))

child.stdout.on('data', (d) => {
  const m = String(d).match(/listening on http:\/\/[^:]+:(\d+)/)
  if (!m || settled) return
  settled = true
  clearTimeout(timer)
  process.stdout.write(JSON.stringify({ port: Number(m[1]), pid: child.pid }) + '\n')
  child.unref()
  process.exit(0)
})
```

- [ ] **Step 6: Write `scripts/lib/broker-lifecycle.mjs`**

```js
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { run, terminate, isAlive } from './process.mjs'
import { OpencodeClient } from './server.mjs'
import { readJson, writeJson } from './state.mjs'
import {
  readEndpoint, writeEndpoint, clearEndpoint, baseUrlFor,
  acquireLock, releaseLock, refsPath,
} from './broker-endpoint.mjs'

const brokerScript = fileURLToPath(new URL('../server-broker.mjs', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function clientFor(rec) {
  return new OpencodeClient(baseUrlFor(rec), { password: rec.password })
}

async function liveEndpoint(env) {
  const rec = await readEndpoint(env)
  if (!rec) return null
  if (rec.pid && !isAlive(rec.pid)) return null
  return (await clientFor(rec).health({ timeoutMs: 2000 })) ? rec : null
}

export async function reapOrphans(env = process.env) {
  const rec = await readEndpoint(env)
  if (!rec) return { cleared: false }
  if (await liveEndpoint(env)) return { cleared: false }
  await clearEndpoint(env)
  return { cleared: true }
}

async function spawnBroker(env) {
  const password = randomBytes(24).toString('hex')
  const r = await run(process.execPath, [brokerScript], {
    env: { ...env, OPENCODE_SERVER_PASSWORD: password },
    timeoutMs: 25_000,
  })
  if (r.code !== 0) {
    throw new Error(`opencode server would not start.\n${r.stderr.trim() || r.stdout.trim()}`)
  }
  const line = r.stdout.trim().split('\n').pop()
  const { port, pid } = JSON.parse(line)
  const rec = { port, pid, password, startedAt: Date.now() }
  await writeEndpoint(rec, env)
  return rec
}

export async function ensureBroker({ env = process.env, timeoutMs = 20_000 } = {}) {
  const existing = await liveEndpoint(env)
  if (existing) return { baseUrl: baseUrlFor(existing), password: existing.password, pid: existing.pid, client: clientFor(existing) }

  await reapOrphans(env)

  if (await acquireLock(env)) {
    try {
      const again = await liveEndpoint(env)
      const rec = again ?? await spawnBroker(env)
      const client = clientFor(rec)
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (await client.health({ timeoutMs: 1500 })) {
          return { baseUrl: baseUrlFor(rec), password: rec.password, pid: rec.pid, client }
        }
        await sleep(200)
      }
      await clearEndpoint(env)
      throw new Error(`opencode server started on port ${rec.port} but never answered GET /doc`)
    } finally {
      await releaseLock(env)
    }
  }

  // Another process is spawning. Wait for its portfile rather than racing it.
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rec = await liveEndpoint(env)
    if (rec) return { baseUrl: baseUrlFor(rec), password: rec.password, pid: rec.pid, client: clientFor(rec) }
    await sleep(200)
  }
  throw new Error('timed out waiting for another process to start the opencode server')
}

export async function addRef(ccSessionId, env = process.env) {
  const refs = await readJson(refsPath(env), {})
  refs[ccSessionId] = Date.now()
  await writeJson(refsPath(env), refs)
  return Object.keys(refs).length
}

export async function releaseRef(ccSessionId, env = process.env) {
  const refs = await readJson(refsPath(env), {})
  delete refs[ccSessionId]
  await writeJson(refsPath(env), refs)
  const remaining = Object.keys(refs).length
  if (remaining > 0) return { remaining, shutdown: false }
  await shutdownBroker(env)
  return { remaining: 0, shutdown: true }
}

export async function shutdownBroker(env = process.env) {
  const rec = await readEndpoint(env)
  await clearEndpoint(env)
  if (!rec?.pid) return 'gone'
  const outcome = await terminate(rec.pid, { graceMs: 3000 })
  return outcome === 'gone' ? 'gone' : 'stopped'
}
```

- [ ] **Step 7: Write the lifecycle integration test**

Create `tests/integration/broker-lifecycle.test.mjs`. It points `OPENCODE_BIN` at the fixture and uses a temp state dir.

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureBroker, addRef, releaseRef, reapOrphans, shutdownBroker } from '../../scripts/lib/broker-lifecycle.mjs'
import { readEndpoint, writeEndpoint } from '../../scripts/lib/broker-endpoint.mjs'
import { isAlive } from '../../scripts/lib/process.mjs'

const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))
const sandbox = async () => ({
  ...process.env,
  OPENCODE_BIN: fixture,
  XDG_STATE_HOME: await mkdtemp(join(tmpdir(), 'ocbl-')),
})

test('ensureBroker starts a server and writes a live portfile', async () => {
  const env = await sandbox()
  const b = await ensureBroker({ env })
  assert.match(b.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(await b.client.health(), true)
  const rec = await readEndpoint(env)
  assert.equal(rec.pid, b.pid)
  assert.ok(rec.password.length >= 16)
  await shutdownBroker(env)
})

test('a second ensureBroker reuses the same server', async () => {
  const env = await sandbox()
  const a = await ensureBroker({ env })
  const b = await ensureBroker({ env })
  assert.equal(a.baseUrl, b.baseUrl)
  assert.equal(a.pid, b.pid)
  await shutdownBroker(env)
})

test('concurrent ensureBroker calls spawn exactly one server', async () => {
  const env = await sandbox()
  const results = await Promise.all([ensureBroker({ env }), ensureBroker({ env }), ensureBroker({ env })])
  assert.equal(new Set(results.map(r => r.pid)).size, 1)
  await shutdownBroker(env)
})

test('reapOrphans clears a portfile whose pid is dead', async () => {
  const env = await sandbox()
  await writeEndpoint({ port: 1, pid: 2 ** 22, password: 'p', startedAt: 0 }, env)
  assert.deepEqual(await reapOrphans(env), { cleared: true })
  assert.equal(await readEndpoint(env), null)
})

test('the broker survives until the last ref is released', async () => {
  const env = await sandbox()
  const b = await ensureBroker({ env })
  await addRef('cc-1', env)
  await addRef('cc-2', env)
  assert.deepEqual(await releaseRef('cc-1', env), { remaining: 1, shutdown: false })
  assert.equal(isAlive(b.pid), true)
  const last = await releaseRef('cc-2', env)
  assert.equal(last.shutdown, true)
  await new Promise(r => setTimeout(r, 300))
  assert.equal(isAlive(b.pid), false)
})

test('a server that will not bind fails with the server stderr', async () => {
  const env = { ...(await sandbox()), FAKE_OPENCODE_FAULT: 'port-bound' }
  await assert.rejects(() => ensureBroker({ env, timeoutMs: 5000 }), /EADDRINUSE|would not start/)
})
```

- [ ] **Step 8: Run the lifecycle tests to verify they pass**

Run: `node --test tests/integration/broker-lifecycle.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 9: Verify basic-auth against the real binary**

The fixture ignores `OPENCODE_SERVER_PASSWORD`; the real server may not. Confirm
the real behavior before trusting it.

Run:

```bash
OPENCODE_SERVER_PASSWORD=testpw ~/.opencode/bin/opencode serve --port 45997 --hostname 127.0.0.1 &
sleep 6
curl -s -o /dev/null -w 'no-auth=%{http_code}\n' http://127.0.0.1:45997/doc
curl -s -o /dev/null -w 'with-auth=%{http_code}\n' -u opencode:testpw http://127.0.0.1:45997/doc
pkill -f 'opencode serve --port 45997'
```

Expected: `with-auth=200`. Record the observed `no-auth` code in a comment at the
top of `broker-lifecycle.mjs`:
- If `no-auth=401`, the password is enforced — keep the client sending it.
- If `no-auth=200`, the password is advisory on this version — still send it (harmless, and correct once enforced) and note that loopback binding is the actual boundary.

Either way the code is unchanged; only the comment is written. Then commit.

- [ ] **Step 10: Commit**

```bash
git add scripts/lib/broker-endpoint.mjs scripts/lib/broker-lifecycle.mjs scripts/server-broker.mjs tests/unit/broker-endpoint.test.mjs tests/integration/broker-lifecycle.test.mjs
git commit -m "feat: spawn-once refcounted opencode server broker"
```

---

## Task 9: `lib/tracked-jobs.mjs` and `lib/job-control.mjs`

**Files:**
- Create: `scripts/lib/tracked-jobs.mjs`, `scripts/lib/job-control.mjs`
- Test: `tests/unit/tracked-jobs.test.mjs`, `tests/integration/job-control.test.mjs`

**Interfaces:**
- Consumes: `jobDir`, `jobsDir`, `sessionsDir`, `readJson`, `writeJson`, `appendJsonl`, `readJsonl`, `ensureDir` (`lib/state.mjs`); `ensureBroker` (`lib/broker-lifecycle.mjs`); `isAlive`, `terminate` (`lib/process.mjs`).
- Produces (`tracked-jobs.mjs`):
  - `newJobId(): string` — `job_<base36 time><6 random hex>`
  - `createJob({ccSessionId, verb, cwd, meta = {}}, env?): Promise<JobRecord>` — writes `<jobDir>/meta.json`; `JobRecord = {id, ccSessionId, verb, cwd, state, sessionID: null, pid: null, startedAt, endedAt: null, error: null, counters: {steps: 0, tools: 0, inputTokens: 0, outputTokens: 0}, meta}`; `state` ∈ `running`|`done`|`failed`|`cancelled`|`stale`
  - `readJob(jobId, env?): Promise<JobRecord|null>`
  - `updateJob(jobId, patch, env?): Promise<JobRecord>` — shallow merge, atomic
  - `listJobs(ccSessionId, env?): Promise<JobRecord[]>` — only this CC session's jobs, newest first
  - `appendEvent(jobId, event, env?): Promise<void>` → `<jobDir>/events.jsonl`
  - `readEvents(jobId, env?): Promise<object[]>`
  - `writeResult(jobId, text, env?): Promise<void>` → `<jobDir>/result.md`
  - `readResult(jobId, env?): Promise<string|null>`
  - `registerSession(ccSessionId, env?): Promise<void>` / `unregisterSession(ccSessionId, env?)` / `knownSessions(env?): Promise<string[]>` — `<sessionsDir>/<ccSessionId>.json`
  - `rememberOpencodeSession(ccSessionId, sessionID, env?)` / `lastOpencodeSession(ccSessionId, env?): Promise<string|null>`
  - `pruneStale(env?): Promise<{stale: string[], removed: string[]}>` — a `running` job whose pid is dead becomes `stale`; job dirs finished more than 7 days ago are removed
- Produces (`job-control.mjs`):
  - `startJob({ccSessionId, verb, prompt, system?, agent?, model?, variant?, cwd, tools?, resumeSessionID?, env?}): Promise<{jobId, sessionID, done: Promise<JobRecord>}>` — creates the opencode session (or reuses `resumeSessionID`), starts SSE consumption, fires `prompt_async`, and returns immediately. `done` resolves when `session.idle` or `session.error` arrives.
  - `runForeground(opts): Promise<JobRecord>` — `startJob` then `await done`
  - `cancelJob(jobId, env?): Promise<'cancelled'|'already-finished'|'unknown'>`
  - `cancelAll(ccSessionId, env?): Promise<string[]>` — ids cancelled

- [ ] **Step 1: Write the failing tracked-jobs test**

Create `tests/unit/tracked-jobs.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  newJobId, createJob, readJob, updateJob, listJobs, appendEvent, readEvents,
  writeResult, readResult, registerSession, knownSessions, unregisterSession,
  rememberOpencodeSession, lastOpencodeSession, pruneStale,
} from '../../scripts/lib/tracked-jobs.mjs'

const sandbox = async () => ({ XDG_STATE_HOME: await mkdtemp(join(tmpdir(), 'ocjobs-')), HOME: '/nonexistent' })

test('newJobId is unique and prefixed', () => {
  const a = newJobId(), b = newJobId()
  assert.match(a, /^job_/)
  assert.notEqual(a, b)
})

test('createJob writes a running record with zeroed counters', async () => {
  const env = await sandbox()
  const job = await createJob({ ccSessionId: 'cc-1', verb: 'review', cwd: '/repo' }, env)
  assert.equal(job.state, 'running')
  assert.deepEqual(job.counters, { steps: 0, tools: 0, inputTokens: 0, outputTokens: 0 })
  assert.deepEqual(await readJob(job.id, env), job)
})

test('updateJob shallow-merges', async () => {
  const env = await sandbox()
  const job = await createJob({ ccSessionId: 'cc-1', verb: 'review', cwd: '/r' }, env)
  const next = await updateJob(job.id, { state: 'done', sessionID: 'ses_1' }, env)
  assert.equal(next.state, 'done')
  assert.equal(next.verb, 'review')
})

test('listJobs is scoped to one Claude Code session, newest first', async () => {
  const env = await sandbox()
  const a = await createJob({ ccSessionId: 'cc-1', verb: 'review', cwd: '/r' }, env)
  await new Promise(r => setTimeout(r, 5))
  const b = await createJob({ ccSessionId: 'cc-1', verb: 'task', cwd: '/r' }, env)
  await createJob({ ccSessionId: 'cc-2', verb: 'task', cwd: '/r' }, env)
  const mine = await listJobs('cc-1', env)
  assert.deepEqual(mine.map(j => j.id), [b.id, a.id])
})

test('events and result round-trip', async () => {
  const env = await sandbox()
  const job = await createJob({ ccSessionId: 'cc-1', verb: 'review', cwd: '/r' }, env)
  await appendEvent(job.id, { type: 'session.idle' }, env)
  assert.deepEqual(await readEvents(job.id, env), [{ type: 'session.idle' }])
  await writeResult(job.id, '# findings', env)
  assert.equal(await readResult(job.id, env), '# findings')
  assert.equal(await readResult('job_missing', env), null)
})

test('session registration and opencode session memory', async () => {
  const env = await sandbox()
  await registerSession('cc-1', env)
  assert.deepEqual(await knownSessions(env), ['cc-1'])
  assert.equal(await lastOpencodeSession('cc-1', env), null)
  await rememberOpencodeSession('cc-1', 'ses_abc', env)
  assert.equal(await lastOpencodeSession('cc-1', env), 'ses_abc')
  await unregisterSession('cc-1', env)
  assert.deepEqual(await knownSessions(env), [])
})

test('pruneStale marks a running job with a dead pid as stale', async () => {
  const env = await sandbox()
  const job = await createJob({ ccSessionId: 'cc-1', verb: 'review', cwd: '/r' }, env)
  await updateJob(job.id, { pid: 2 ** 22 }, env)
  const res = await pruneStale(env)
  assert.deepEqual(res.stale, [job.id])
  assert.equal((await readJob(job.id, env)).state, 'stale')
})

test('pruneStale leaves a finished job alone', async () => {
  const env = await sandbox()
  const job = await createJob({ ccSessionId: 'cc-1', verb: 'review', cwd: '/r' }, env)
  await updateJob(job.id, { state: 'done', endedAt: Date.now() }, env)
  assert.deepEqual((await pruneStale(env)).stale, [])
  assert.equal((await readJob(job.id, env)).state, 'done')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/tracked-jobs.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/lib/tracked-jobs.mjs'`

- [ ] **Step 3: Write `scripts/lib/tracked-jobs.mjs`**

```js
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import { jobsDir, jobDir, sessionsDir, readJson, writeJson, appendJsonl, readJsonl, ensureDir } from './state.mjs'
import { atomicWrite } from './fs.mjs'
import { isAlive } from './process.mjs'

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export function newJobId() {
  return `job_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
}

export async function createJob({ ccSessionId, verb, cwd, meta = {} }, env = process.env) {
  const job = {
    id: newJobId(),
    ccSessionId,
    verb,
    cwd,
    state: 'running',
    sessionID: null,
    pid: process.pid,
    startedAt: Date.now(),
    endedAt: null,
    error: null,
    counters: { steps: 0, tools: 0, inputTokens: 0, outputTokens: 0 },
    meta,
  }
  await ensureDir(jobDir(job.id, env))
  await writeJson(join(jobDir(job.id, env), 'meta.json'), job)
  return job
}

export const readJob = (jobId, env = process.env) => readJson(join(jobDir(jobId, env), 'meta.json'), null)

export async function updateJob(jobId, patch, env = process.env) {
  const current = await readJob(jobId, env)
  if (!current) throw new Error(`unknown job: ${jobId}`)
  const next = { ...current, ...patch }
  await writeJson(join(jobDir(jobId, env), 'meta.json'), next)
  return next
}

export async function listJobs(ccSessionId, env = process.env) {
  let ids = []
  try { ids = await readdir(jobsDir(env)) } catch { return [] }
  const jobs = []
  for (const id of ids) {
    const j = await readJob(id, env)
    if (j && j.ccSessionId === ccSessionId) jobs.push(j)
  }
  return jobs.sort((a, b) => b.startedAt - a.startedAt)
}

export const appendEvent = (jobId, event, env = process.env) =>
  appendJsonl(join(jobDir(jobId, env), 'events.jsonl'), event)

export const readEvents = (jobId, env = process.env) =>
  readJsonl(join(jobDir(jobId, env), 'events.jsonl'))

export async function writeResult(jobId, text, env = process.env) {
  await ensureDir(jobDir(jobId, env))
  await atomicWrite(join(jobDir(jobId, env), 'result.md'), text)
}

export async function readResult(jobId, env = process.env) {
  try { return await readFile(join(jobDir(jobId, env), 'result.md'), 'utf8') } catch { return null }
}

const sessionFile = (ccSessionId, env) => join(sessionsDir(env), `${encodeURIComponent(ccSessionId)}.json`)

export async function registerSession(ccSessionId, env = process.env) {
  const existing = await readJson(sessionFile(ccSessionId, env), null)
  await writeJson(sessionFile(ccSessionId, env), { ccSessionId, registeredAt: Date.now(), lastOpencodeSession: existing?.lastOpencodeSession ?? null })
}

export async function unregisterSession(ccSessionId, env = process.env) {
  await rm(sessionFile(ccSessionId, env), { force: true })
}

export async function knownSessions(env = process.env) {
  try {
    return (await readdir(sessionsDir(env))).filter(f => f.endsWith('.json')).map(f => decodeURIComponent(f.slice(0, -5))).sort()
  } catch { return [] }
}

export async function rememberOpencodeSession(ccSessionId, sessionID, env = process.env) {
  const rec = (await readJson(sessionFile(ccSessionId, env), null)) ?? { ccSessionId, registeredAt: Date.now() }
  rec.lastOpencodeSession = sessionID
  await writeJson(sessionFile(ccSessionId, env), rec)
}

export async function lastOpencodeSession(ccSessionId, env = process.env) {
  return (await readJson(sessionFile(ccSessionId, env), null))?.lastOpencodeSession ?? null
}

export async function pruneStale(env = process.env) {
  let ids = []
  try { ids = await readdir(jobsDir(env)) } catch { return { stale: [], removed: [] } }
  const stale = [], removed = []
  for (const id of ids) {
    const j = await readJob(id, env)
    if (!j) continue
    if (j.state === 'running' && j.pid && !isAlive(j.pid)) {
      await updateJob(id, { state: 'stale', endedAt: Date.now() }, env)
      stale.push(id)
      continue
    }
    if (j.endedAt && Date.now() - j.endedAt > RETENTION_MS) {
      await rm(jobDir(id, env), { recursive: true, force: true })
      removed.push(id)
    }
  }
  return { stale, removed }
}
```

- [ ] **Step 4: Run the tracked-jobs tests to verify they pass**

Run: `node --test tests/unit/tracked-jobs.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 5: Write `scripts/lib/job-control.mjs`**

```js
import { ensureBroker } from './broker-lifecycle.mjs'
import {
  createJob, updateJob, readJob, appendEvent, writeResult, listJobs,
  rememberOpencodeSession,
} from './tracked-jobs.mjs'

const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function applyCounters(counters, ev) {
  if (ev.type === 'session.next.step.started') counters.steps++
  if (ev.type === 'session.next.tool.called') counters.tools++
  if (ev.type === 'message.updated') {
    const t = ev.properties?.info?.tokens
    if (t) {
      counters.inputTokens = t.input ?? counters.inputTokens
      counters.outputTokens = t.output ?? counters.outputTokens
    }
  }
  return counters
}

export async function startJob({
  ccSessionId, verb, prompt, system, agent, model, variant, cwd,
  tools, resumeSessionID, env = process.env,
}) {
  const broker = await ensureBroker({ env })
  const job = await createJob({ ccSessionId, verb, cwd, meta: { agent, model, variant } }, env)

  const sessionID = resumeSessionID
    ?? (await broker.client.createSession({ title: `claude-code ${verb}`, agent })).id
  await updateJob(job.id, { sessionID }, env)
  await rememberOpencodeSession(ccSessionId, sessionID, env)

  let text = ''
  const counters = { ...job.counters }
  let finished = null

  const consume = (async () => {
    for (let attempt = 0; attempt <= RECONNECT_DELAYS_MS.length; attempt++) {
      const ac = new AbortController()
      try {
        await broker.client.events({
          signal: ac.signal,
          onEvent: (ev) => {
            if (ev.properties?.sessionID && ev.properties.sessionID !== sessionID) return
            appendEvent(job.id, ev, env).catch(() => {})
            applyCounters(counters, ev)
            if (ev.type === 'session.next.text.delta' && ev.properties?.delta) text += ev.properties.delta
            if (ev.type === 'session.idle') { finished = { state: 'done' }; ac.abort() }
            if (ev.type === 'session.error') {
              const name = ev.properties?.error?.name ?? 'UnknownError'
              finished = { state: name === 'MessageAbortedError' ? 'cancelled' : 'failed', error: name }
              ac.abort()
            }
          },
        })
      } catch (err) {
        if (finished) break
        if (attempt === RECONNECT_DELAYS_MS.length) {
          finished = { state: 'failed', error: `event stream lost: ${err.message}` }
          break
        }
        await sleep(RECONNECT_DELAYS_MS[attempt])
        continue
      }
      if (finished) break
      // Stream ended cleanly without a terminal event — reconnect.
      if (attempt < RECONNECT_DELAYS_MS.length) await sleep(RECONNECT_DELAYS_MS[attempt])
    }
    await writeResult(job.id, text, env)
    return updateJob(job.id, {
      state: finished?.state ?? 'failed',
      error: finished?.error ?? null,
      endedAt: Date.now(),
      counters,
    }, env)
  })()

  // Give the SSE stream a moment to attach before the prompt starts producing events.
  await sleep(150)
  const body = { parts: [{ type: 'text', text: prompt }] }
  if (agent) body.agent = agent
  if (variant) body.variant = variant
  if (system) body.system = system
  if (tools) body.tools = tools
  if (model) {
    const slash = model.indexOf('/')
    body.model = { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
  }
  await broker.client.promptAsync(sessionID, body)

  return { jobId: job.id, sessionID, done: consume }
}

export async function runForeground(opts) {
  const { done } = await startJob(opts)
  return done
}

export async function cancelJob(jobId, env = process.env) {
  const job = await readJob(jobId, env)
  if (!job) return 'unknown'
  if (job.state !== 'running') return 'already-finished'
  const broker = await ensureBroker({ env })
  if (job.sessionID) await broker.client.abort(job.sessionID).catch(() => {})
  await updateJob(jobId, { state: 'cancelled', endedAt: Date.now() }, env)
  return 'cancelled'
}

export async function cancelAll(ccSessionId, env = process.env) {
  const cancelled = []
  for (const job of await listJobs(ccSessionId, env)) {
    if (job.state !== 'running') continue
    if (await cancelJob(job.id, env) === 'cancelled') cancelled.push(job.id)
  }
  return cancelled
}
```

- [ ] **Step 6: Write the job-control integration test**

Create `tests/integration/job-control.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startJob, runForeground, cancelJob } from '../../scripts/lib/job-control.mjs'
import { readJob, readEvents, readResult, lastOpencodeSession } from '../../scripts/lib/tracked-jobs.mjs'
import { shutdownBroker } from '../../scripts/lib/broker-lifecycle.mjs'

const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))
const sandbox = async (extra = {}) => ({
  ...process.env,
  OPENCODE_BIN: fixture,
  XDG_STATE_HOME: await mkdtemp(join(tmpdir(), 'ocjc-')),
  ...extra,
})

test('a foreground job runs to done and captures text, events, and counters', async () => {
  const env = await sandbox()
  const job = await runForeground({ ccSessionId: 'cc-1', verb: 'review', prompt: 'review', cwd: '/r', env })
  assert.equal(job.state, 'done')
  assert.ok(job.counters.tools >= 1)
  assert.ok(job.counters.outputTokens > 0)
  const result = await readResult(job.id, env)
  assert.match(result, /"findings"/)
  assert.ok((await readEvents(job.id, env)).length > 0)
  assert.equal(await lastOpencodeSession('cc-1', env), job.sessionID)
  await shutdownBroker(env)
})

test('a background job returns immediately and settles later', async () => {
  const env = await sandbox({ FAKE_OPENCODE_EVENT_DELAY_MS: '80' })
  const { jobId, done } = await startJob({ ccSessionId: 'cc-1', verb: 'review', prompt: 'p', cwd: '/r', env })
  assert.equal((await readJob(jobId, env)).state, 'running')
  const settled = await done
  assert.equal(settled.state, 'done')
  await shutdownBroker(env)
})

test('cancelJob aborts a running job', async () => {
  const env = await sandbox({ FAKE_OPENCODE_EVENT_DELAY_MS: '300' })
  const { jobId, done } = await startJob({ ccSessionId: 'cc-1', verb: 'task', prompt: 'p', cwd: '/r', env })
  assert.equal(await cancelJob(jobId, env), 'cancelled')
  await done
  assert.equal((await readJob(jobId, env)).state, 'cancelled')
  await shutdownBroker(env)
})

test('cancelJob on an unknown id reports unknown', async () => {
  const env = await sandbox()
  assert.equal(await cancelJob('job_nope', env), 'unknown')
})

test('an SSE disconnect mid-job reconnects and still reaches a terminal state', async () => {
  const env = await sandbox({ FAKE_OPENCODE_FAULT: 'sse-disconnect' })
  const job = await runForeground({ ccSessionId: 'cc-1', verb: 'review', prompt: 'p', cwd: '/r', env })
  assert.ok(['done', 'failed'].includes(job.state))
  assert.ok((await readEvents(job.id, env)).length > 0, 'partial events must survive the disconnect')
  await shutdownBroker(env)
})
```

- [ ] **Step 7: Run the job-control tests to verify they pass**

Run: `node --test tests/integration/job-control.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/tracked-jobs.mjs scripts/lib/job-control.mjs tests/unit/tracked-jobs.test.mjs tests/integration/job-control.test.mjs
git commit -m "feat: per-session job records and SSE-driven job control"
```

---

## Task 10: `lib/git.mjs` — scope resolution, diff collection, and sizing

Untracked files count as reviewable work. Concluding "nothing to review" when
`git diff --shortstat` is empty but untracked files exist is the bug this task
exists to prevent.

**Files:**
- Create: `scripts/lib/git.mjs`
- Test: `tests/unit/git.test.mjs`

**Interfaces:**
- Consumes: `run` (`lib/process.mjs`).
- Produces:
  - `defaultBase(cwd): Promise<string>` — the upstream of HEAD (`@{u}`) if set, else `origin/main`, `origin/master`, `main`, `master` — first that resolves via `git rev-parse --verify`; falls back to `HEAD`
  - `resolveScope({cwd, scope = 'auto', base?}): Promise<{scope: 'working-tree'|'branch', base: string|null}>` — `auto` → `branch` when `git rev-list --count <base>..HEAD` > 0, else `working-tree`
  - `sizeChange({cwd, scope, base}): Promise<{files: number, insertions: number, deletions: number, untracked: string[], empty: boolean, tiny: boolean}>` — `tiny` is `files + untracked.length <= 2` and no untracked directory; `empty` is true only when tracked stats are zero **and** `untracked` is empty
  - `collectDiff({cwd, scope, base, maxBytes = 400_000}): Promise<{text: string, truncated: boolean}>` — `git diff` for the scope, plus a `--- untracked: <path>` section with the contents of each untracked file under 64 KiB (binary files listed by name only)
  - `repoRoot(cwd): Promise<string>` — `git rev-parse --show-toplevel`; throws `not a git repository` when it fails

- [ ] **Step 1: Write the failing test**

Create `tests/unit/git.test.mjs`. It builds real throwaway repos — no mocking git.

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../../scripts/lib/process.mjs'
import { repoRoot, defaultBase, resolveScope, sizeChange, collectDiff } from '../../scripts/lib/git.mjs'

async function repo() {
  const d = await mkdtemp(join(tmpdir(), 'ocgit-'))
  const git = (...a) => run('git', a, { cwd: d, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } })
  await git('init', '-b', 'main')
  await writeFile(join(d, 'a.txt'), 'one\n')
  await git('add', '.')
  await git('commit', '-m', 'init')
  return { dir: d, git }
}

test('repoRoot resolves and rejects outside a repo', async () => {
  const r = await repo()
  assert.equal(await repoRoot(r.dir), await repoRoot(r.dir))
  const bare = await mkdtemp(join(tmpdir(), 'ocnogit-'))
  await assert.rejects(() => repoRoot(bare), /not a git repository/)
})

test('sizeChange reports an empty clean tree', async () => {
  const r = await repo()
  const s = await sizeChange({ cwd: r.dir, scope: 'working-tree', base: null })
  assert.equal(s.empty, true)
  assert.deepEqual(s.untracked, [])
})

test('sizeChange counts modified tracked files', async () => {
  const r = await repo()
  await writeFile(join(r.dir, 'a.txt'), 'one\ntwo\n')
  const s = await sizeChange({ cwd: r.dir, scope: 'working-tree', base: null })
  assert.equal(s.empty, false)
  assert.equal(s.files, 1)
  assert.equal(s.insertions, 1)
  assert.equal(s.tiny, true)
})

test('untracked files alone are NOT empty', async () => {
  const r = await repo()
  await writeFile(join(r.dir, 'new.txt'), 'hello\n')
  const s = await sizeChange({ cwd: r.dir, scope: 'working-tree', base: null })
  assert.equal(s.empty, false)
  assert.deepEqual(s.untracked, ['new.txt'])
})

test('an untracked directory is not tiny', async () => {
  const r = await repo()
  await mkdir(join(r.dir, 'pkg', 'sub'), { recursive: true })
  await writeFile(join(r.dir, 'pkg', 'x.txt'), 'x\n')
  await writeFile(join(r.dir, 'pkg', 'sub', 'y.txt'), 'y\n')
  const s = await sizeChange({ cwd: r.dir, scope: 'working-tree', base: null })
  assert.equal(s.tiny, false)
})

test('sizeChange counts staged changes', async () => {
  const r = await repo()
  await writeFile(join(r.dir, 'a.txt'), 'one\ntwo\n')
  await r.git('add', 'a.txt')
  const s = await sizeChange({ cwd: r.dir, scope: 'working-tree', base: null })
  assert.equal(s.empty, false)
  assert.equal(s.insertions, 1)
})

test('resolveScope picks branch when HEAD is ahead of base', async () => {
  const r = await repo()
  await r.git('branch', 'base-ref')
  await writeFile(join(r.dir, 'b.txt'), 'b\n')
  await r.git('add', '.')
  await r.git('commit', '-m', 'second')
  assert.deepEqual(await resolveScope({ cwd: r.dir, scope: 'auto', base: 'base-ref' }), { scope: 'branch', base: 'base-ref' })
})

test('resolveScope picks working-tree when HEAD is not ahead', async () => {
  const r = await repo()
  const s = await resolveScope({ cwd: r.dir, scope: 'auto', base: 'HEAD' })
  assert.equal(s.scope, 'working-tree')
})

test('an explicit scope is obeyed without inspecting the repo', async () => {
  const r = await repo()
  assert.equal((await resolveScope({ cwd: r.dir, scope: 'branch', base: 'HEAD' })).scope, 'branch')
})

test('defaultBase falls back to a local main', async () => {
  const r = await repo()
  assert.ok(['main', 'HEAD'].includes(await defaultBase(r.dir)))
})

test('collectDiff includes tracked changes and untracked file contents', async () => {
  const r = await repo()
  await writeFile(join(r.dir, 'a.txt'), 'one\ntwo\n')
  await writeFile(join(r.dir, 'new.txt'), 'brand new\n')
  const d = await collectDiff({ cwd: r.dir, scope: 'working-tree', base: null })
  assert.match(d.text, /\+two/)
  assert.match(d.text, /--- untracked: new\.txt/)
  assert.match(d.text, /brand new/)
  assert.equal(d.truncated, false)
})

test('collectDiff truncates and flags oversized diffs', async () => {
  const r = await repo()
  await writeFile(join(r.dir, 'big.txt'), 'x\n'.repeat(200_000))
  const d = await collectDiff({ cwd: r.dir, scope: 'working-tree', base: null, maxBytes: 2000 })
  assert.equal(d.truncated, true)
  assert.ok(d.text.length <= 2200)
})

test('collectDiff on a branch scope diffs against the merge base', async () => {
  const r = await repo()
  await r.git('branch', 'base-ref')
  await writeFile(join(r.dir, 'c.txt'), 'c\n')
  await r.git('add', '.')
  await r.git('commit', '-m', 'third')
  const d = await collectDiff({ cwd: r.dir, scope: 'branch', base: 'base-ref' })
  assert.match(d.text, /c\.txt/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/git.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/lib/git.mjs'`

- [ ] **Step 3: Write `scripts/lib/git.mjs`**

```js
import { join } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { run } from './process.mjs'

const MAX_UNTRACKED_BYTES = 64 * 1024

async function git(cwd, args, { timeoutMs = 30000 } = {}) {
  return run('git', args, { cwd, timeoutMs })
}

export async function repoRoot(cwd) {
  const r = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (r.code !== 0) throw new Error(`not a git repository: ${cwd}`)
  return r.stdout.trim()
}

async function refExists(cwd, ref) {
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', ref])).code === 0
}

export async function defaultBase(cwd) {
  const up = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (up.code === 0 && up.stdout.trim()) return up.stdout.trim()
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await refExists(cwd, ref)) return ref
  }
  return 'HEAD'
}

export async function resolveScope({ cwd, scope = 'auto', base }) {
  const resolvedBase = base || await defaultBase(cwd)
  if (scope === 'branch') return { scope: 'branch', base: resolvedBase }
  if (scope === 'working-tree') return { scope: 'working-tree', base: null }
  const r = await git(cwd, ['rev-list', '--count', `${resolvedBase}..HEAD`])
  const ahead = r.code === 0 && Number(r.stdout.trim()) > 0
  return ahead ? { scope: 'branch', base: resolvedBase } : { scope: 'working-tree', base: null }
}

function parseShortstat(text) {
  const files = Number(text.match(/(\d+) files? changed/)?.[1] ?? 0)
  const insertions = Number(text.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0)
  const deletions = Number(text.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0)
  return { files, insertions, deletions }
}

async function untrackedPaths(cwd) {
  const r = await git(cwd, ['status', '--short', '--untracked-files=all'])
  if (r.code !== 0) return []
  return r.stdout.split('\n')
    .filter(l => l.startsWith('?? '))
    .map(l => l.slice(3).trim())
    .filter(Boolean)
}

export async function sizeChange({ cwd, scope, base }) {
  let stats = { files: 0, insertions: 0, deletions: 0 }
  let untracked = []
  if (scope === 'branch') {
    stats = parseShortstat((await git(cwd, ['diff', '--shortstat', `${base}...HEAD`])).stdout)
  } else {
    const staged = parseShortstat((await git(cwd, ['diff', '--shortstat', '--cached'])).stdout)
    const unstaged = parseShortstat((await git(cwd, ['diff', '--shortstat'])).stdout)
    stats = {
      files: Math.max(staged.files, unstaged.files),
      insertions: staged.insertions + unstaged.insertions,
      deletions: staged.deletions + unstaged.deletions,
    }
    untracked = await untrackedPaths(cwd)
  }
  const empty = stats.files === 0 && stats.insertions === 0 && stats.deletions === 0 && untracked.length === 0
  const touchesDirectory = untracked.some(p => p.includes('/'))
  const tiny = !empty && !touchesDirectory && (stats.files + untracked.length) <= 2
  return { ...stats, untracked, empty, tiny }
}

export async function collectDiff({ cwd, scope, base, maxBytes = 400_000 }) {
  let text = ''
  if (scope === 'branch') {
    text += (await git(cwd, ['diff', `${base}...HEAD`], { timeoutMs: 60000 })).stdout
  } else {
    text += (await git(cwd, ['diff', 'HEAD'], { timeoutMs: 60000 })).stdout
    for (const path of await untrackedPaths(cwd)) {
      text += `\n--- untracked: ${path}\n`
      try {
        const full = join(cwd, path)
        const s = await stat(full)
        if (!s.isFile()) { text += '(directory)\n'; continue }
        if (s.size > MAX_UNTRACKED_BYTES) { text += `(${s.size} bytes, omitted)\n`; continue }
        const buf = await readFile(full)
        if (buf.includes(0)) { text += '(binary, omitted)\n'; continue }
        text += buf.toString('utf8')
      } catch (err) {
        text += `(unreadable: ${err.code || err.message})\n`
      }
    }
  }
  if (text.length > maxBytes) {
    return { text: text.slice(0, maxBytes) + '\n\n[diff truncated]\n', truncated: true }
  }
  return { text, truncated: false }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/git.test.mjs`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/git.mjs tests/unit/git.test.mjs
git commit -m "feat: git scope resolution, diff collection, and untracked-aware sizing"
```

---

## Task 11: Prompts, the review schema, validation, and rendering

Unparseable model output is rendered raw with a note — never discarded. That is
the single most important behavior in this task.

**Files:**
- Create: `prompts/review.md`, `prompts/adversarial-review.md`, `prompts/stop-review-gate.md`, `schemas/review-output.schema.json`, `scripts/lib/prompts.mjs`, `scripts/lib/review-schema.mjs`, `scripts/lib/render.mjs`
- Test: `tests/unit/prompts.test.mjs`, `tests/unit/review-schema.test.mjs`, `tests/unit/render.test.mjs`

**Interfaces:**
- Consumes: nothing outside `node:` builtins.
- Produces (`prompts.mjs`):
  - `loadPrompt(name: string, vars: Record<string, string> = {}): Promise<string>` — reads `prompts/<name>.md`, substitutes `{{KEY}}` placeholders, and throws `unknown placeholder` if any `{{...}}` remains
  - `listPrompts(): Promise<string[]>`
- Produces (`review-schema.mjs`):
  - `SEVERITIES = ['critical','high','medium','low','info']`, `CONFIDENCES = ['high','medium','low']`
  - `extractJson(text: string): string|null` — pulls the first balanced `{...}` block, tolerating a ```json fence and surrounding prose
  - `validateReview(obj): {ok: true, findings: Finding[]} | {ok: false, error: string}` — hand-written validation against `schemas/review-output.schema.json`. `Finding = {file: string, line: number|null, severity: string, confidence: string, body: string, title?: string}`
  - `parseReviewOutput(text): {ok: boolean, findings: Finding[], summary: string|null, raw: string, error: string|null}` — never throws
- Produces (`render.mjs`):
  - `renderReview({findings, summary, ok, raw, error}, {scope, base, truncated, jobId}): string`
  - `renderJobList(jobs: JobRecord[], now = Date.now()): string`
  - `renderJobResult(job: JobRecord, resultText: string|null): string`
  - `renderDoctor(report): string` — the readable table for `--status`
  - `formatElapsed(ms: number): string` — `4s`, `2m 10s`, `1h 3m`

- [ ] **Step 1: Write `schemas/review-output.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "opencode-plugin-cc review output",
  "type": "object",
  "required": ["findings"],
  "properties": {
    "summary": { "type": "string" },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["file", "severity", "confidence", "body"],
        "properties": {
          "file": { "type": "string", "minLength": 1 },
          "line": { "type": ["integer", "null"], "minimum": 1 },
          "title": { "type": "string" },
          "severity": { "enum": ["critical", "high", "medium", "low", "info"] },
          "confidence": { "enum": ["high", "medium", "low"] },
          "body": { "type": "string", "minLength": 1 }
        },
        "additionalProperties": false
      }
    }
  },
  "additionalProperties": false
}
```

- [ ] **Step 2: Write the three prompt templates**

`prompts/review.md`:

```markdown
You are reviewing a code change. Report defects only. Do not fix anything, do not
propose refactors, do not comment on style unless it causes a defect.

Repository: {{CWD}}
Scope: {{SCOPE}}{{BASE_NOTE}}

The complete change is below. You already have it — do not run shell commands to
fetch it. Use the read tool only to see surrounding context in files the change
touches.

<change>
{{DIFF}}
</change>

Report every defect you are confident in. For each one give the file, the line if
you can pin it, a severity, your confidence, and a body explaining the concrete
failure: what input or state triggers it and what goes wrong.

Respond with JSON and nothing else, in exactly this shape:

{
  "summary": "one sentence on the overall state of the change",
  "findings": [
    {
      "file": "path/relative/to/repo.js",
      "line": 42,
      "title": "short label",
      "severity": "critical|high|medium|low|info",
      "confidence": "high|medium|low",
      "body": "What breaks, under what conditions, and why."
    }
  ]
}

If the change has no defects, return {"summary": "...", "findings": []}.
```

`prompts/adversarial-review.md`: same header and `<change>` block and the same
JSON contract, but the instruction body reads:

```markdown
You are adversarially reviewing a code change. Defects matter, but your primary
job is to challenge the change's premises: is this the right approach, is the
abstraction earning its keep, does the design hold under load, concurrency,
failure, or a second caller? Attack assumptions the author did not state.

Focus from the requester: {{FOCUS}}
```

with `{{FOCUS}}` rendered as `(none given)` when the user supplied no focus text.

`prompts/stop-review-gate.md`: same contract, plus this instruction:

```markdown
This is a pre-completion gate. Report ONLY findings severe enough to block: a
correctness bug, a data-loss risk, a security hole, or a broken build. Style,
naming, and preference belong nowhere in this output. An empty findings list is
the expected and correct answer for most turns.
```

- [ ] **Step 3: Write the failing tests**

Create `tests/unit/prompts.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPrompt, listPrompts } from '../../scripts/lib/prompts.mjs'

test('all three prompt templates ship', async () => {
  const names = await listPrompts()
  for (const n of ['review', 'adversarial-review', 'stop-review-gate']) assert.ok(names.includes(n), n)
})

test('loadPrompt substitutes placeholders', async () => {
  const out = await loadPrompt('review', { CWD: '/repo', SCOPE: 'working-tree', BASE_NOTE: '', DIFF: 'DIFFHERE' })
  assert.match(out, /\/repo/)
  assert.match(out, /DIFFHERE/)
  assert.equal(out.includes('{{'), false)
})

test('loadPrompt throws when a placeholder is unfilled', async () => {
  await assert.rejects(() => loadPrompt('review', { CWD: '/r' }), /unknown placeholder/)
})

test('loadPrompt throws for an unknown template', async () => {
  await assert.rejects(() => loadPrompt('nope', {}), /unknown prompt/)
})
```

Create `tests/unit/review-schema.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractJson, validateReview, parseReviewOutput } from '../../scripts/lib/review-schema.mjs'

test('extractJson finds a bare object', () => {
  assert.equal(extractJson('{"a":1}'), '{"a":1}')
})

test('extractJson strips a fenced block and surrounding prose', () => {
  assert.equal(extractJson('Here you go:\n```json\n{"a":1}\n```\nthanks'), '{"a":1}')
})

test('extractJson handles braces inside strings', () => {
  assert.equal(extractJson('{"body":"use {} carefully"}'), '{"body":"use {} carefully"}')
})

test('extractJson returns null when there is no object', () => {
  assert.equal(extractJson('no json here'), null)
})

test('validateReview accepts a well-formed report', () => {
  const r = validateReview({ summary: 's', findings: [{ file: 'a.js', line: 1, severity: 'high', confidence: 'high', body: 'boom' }] })
  assert.equal(r.ok, true)
  assert.equal(r.findings.length, 1)
})

test('validateReview accepts an empty findings list', () => {
  assert.equal(validateReview({ findings: [] }).ok, true)
})

test('validateReview rejects a bad severity', () => {
  const r = validateReview({ findings: [{ file: 'a.js', severity: 'catastrophic', confidence: 'high', body: 'x' }] })
  assert.equal(r.ok, false)
  assert.match(r.error, /severity/)
})

test('validateReview rejects a missing required field', () => {
  const r = validateReview({ findings: [{ file: 'a.js', severity: 'high', confidence: 'high' }] })
  assert.equal(r.ok, false)
  assert.match(r.error, /body/)
})

test('validateReview rejects a non-array findings value', () => {
  assert.equal(validateReview({ findings: 'lots' }).ok, false)
})

test('parseReviewOutput returns findings for good output', () => {
  const r = parseReviewOutput('```json\n{"summary":"ok","findings":[{"file":"a.js","line":3,"severity":"low","confidence":"medium","body":"nit"}]}\n```')
  assert.equal(r.ok, true)
  assert.equal(r.summary, 'ok')
  assert.equal(r.findings[0].file, 'a.js')
})

test('parseReviewOutput never throws and keeps the raw text', () => {
  const r = parseReviewOutput('the model rambled and produced no json')
  assert.equal(r.ok, false)
  assert.equal(r.raw, 'the model rambled and produced no json')
  assert.ok(r.error)
  assert.deepEqual(r.findings, [])
})

test('parseReviewOutput keeps raw text for valid JSON that fails the schema', () => {
  const r = parseReviewOutput('{"findings":[{"file":"a.js","severity":"nope","confidence":"high","body":"x"}]}')
  assert.equal(r.ok, false)
  assert.match(r.raw, /nope/)
})
```

Create `tests/unit/render.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderReview, renderJobList, renderJobResult, formatElapsed } from '../../scripts/lib/render.mjs'

test('formatElapsed formats seconds, minutes, and hours', () => {
  assert.equal(formatElapsed(4000), '4s')
  assert.equal(formatElapsed(130000), '2m 10s')
  assert.equal(formatElapsed(3_780_000), '1h 3m')
})

test('renderReview groups findings by severity, worst first', () => {
  const out = renderReview({
    ok: true,
    summary: 'two problems',
    findings: [
      { file: 'b.js', line: 2, severity: 'low', confidence: 'low', body: 'nit' },
      { file: 'a.js', line: 9, severity: 'critical', confidence: 'high', title: 'boom', body: 'crashes on null' },
    ],
  }, { scope: 'working-tree', base: null, truncated: false, jobId: 'job_1' })
  assert.ok(out.indexOf('a.js:9') < out.indexOf('b.js:2'))
  assert.match(out, /CRITICAL/)
  assert.match(out, /crashes on null/)
})

test('renderReview states plainly when there are no findings', () => {
  const out = renderReview({ ok: true, summary: 'clean', findings: [] }, { scope: 'branch', base: 'main', truncated: false, jobId: 'job_1' })
  assert.match(out, /No findings/)
})

test('renderReview prints raw output with a note when parsing failed', () => {
  const out = renderReview({ ok: false, findings: [], summary: null, raw: 'MODEL SAID THIS', error: 'no JSON object found' },
    { scope: 'working-tree', base: null, truncated: false, jobId: 'job_1' })
  assert.match(out, /MODEL SAID THIS/)
  assert.match(out, /could not be parsed/i)
  assert.match(out, /no JSON object found/)
})

test('renderReview notes a truncated diff', () => {
  const out = renderReview({ ok: true, summary: 's', findings: [] }, { scope: 'working-tree', base: null, truncated: true, jobId: 'job_1' })
  assert.match(out, /truncated/i)
})

test('renderJobList shows id, verb, state, elapsed, and counters', () => {
  const now = 1_000_000
  const out = renderJobList([
    { id: 'job_a', verb: 'review', state: 'running', startedAt: now - 5000, endedAt: null, counters: { steps: 2, tools: 3, inputTokens: 10, outputTokens: 20 } },
  ], now)
  assert.match(out, /job_a/)
  assert.match(out, /review/)
  assert.match(out, /running/)
  assert.match(out, /5s/)
  assert.match(out, /3 tools/)
})

test('renderJobList says so when there are no jobs', () => {
  assert.match(renderJobList([]), /No opencode jobs/)
})

test('renderJobResult banners a still-running job above its partial output', () => {
  const out = renderJobResult({ id: 'job_a', verb: 'review', state: 'running', startedAt: 0, counters: {} }, 'partial text')
  assert.match(out, /still running/i)
  assert.match(out, /partial text/)
})

test('renderJobResult reports a job with no output yet', () => {
  const out = renderJobResult({ id: 'job_a', verb: 'task', state: 'running', startedAt: 0, counters: {} }, null)
  assert.match(out, /no output yet/i)
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test tests/unit/prompts.test.mjs tests/unit/review-schema.test.mjs tests/unit/render.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/lib/prompts.mjs'`

- [ ] **Step 5: Write `scripts/lib/prompts.mjs`**

```js
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const promptsDir = fileURLToPath(new URL('../../prompts/', import.meta.url))

export async function listPrompts() {
  return (await readdir(promptsDir)).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort()
}

export async function loadPrompt(name, vars = {}) {
  let text
  try {
    text = await readFile(promptsDir + name + '.md', 'utf8')
  } catch {
    throw new Error(`unknown prompt template: ${name}`)
  }
  const filled = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, key) =>
    Object.hasOwn(vars, key) ? String(vars[key]) : m)
  const leftover = filled.match(/\{\{([A-Z0-9_]+)\}\}/)
  if (leftover) throw new Error(`unknown placeholder in prompt ${name}: ${leftover[1]}`)
  return filled
}
```

- [ ] **Step 6: Write `scripts/lib/review-schema.mjs`**

```js
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']
export const CONFIDENCES = ['high', 'medium', 'low']

export function extractJson(text) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0, inString = false, escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

export function validateReview(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'review output must be a JSON object' }
  }
  if (!Array.isArray(obj.findings)) {
    return { ok: false, error: 'review output requires a "findings" array' }
  }
  if (obj.summary !== undefined && typeof obj.summary !== 'string') {
    return { ok: false, error: '"summary" must be a string when present' }
  }
  const findings = []
  for (const [i, f] of obj.findings.entries()) {
    const at = `findings[${i}]`
    if (f === null || typeof f !== 'object' || Array.isArray(f)) return { ok: false, error: `${at} must be an object` }
    if (typeof f.file !== 'string' || !f.file) return { ok: false, error: `${at}.file must be a non-empty string` }
    if (typeof f.body !== 'string' || !f.body) return { ok: false, error: `${at}.body must be a non-empty string` }
    if (!SEVERITIES.includes(f.severity)) return { ok: false, error: `${at}.severity must be one of ${SEVERITIES.join(', ')}` }
    if (!CONFIDENCES.includes(f.confidence)) return { ok: false, error: `${at}.confidence must be one of ${CONFIDENCES.join(', ')}` }
    if (f.line !== undefined && f.line !== null && !(Number.isInteger(f.line) && f.line >= 1)) {
      return { ok: false, error: `${at}.line must be a positive integer or null` }
    }
    if (f.title !== undefined && typeof f.title !== 'string') return { ok: false, error: `${at}.title must be a string` }
    findings.push({
      file: f.file,
      line: f.line ?? null,
      title: f.title,
      severity: f.severity,
      confidence: f.confidence,
      body: f.body,
    })
  }
  return { ok: true, findings }
}

export function parseReviewOutput(text) {
  const raw = typeof text === 'string' ? text : String(text ?? '')
  const json = extractJson(raw)
  if (!json) return { ok: false, findings: [], summary: null, raw, error: 'no JSON object found in model output' }
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    return { ok: false, findings: [], summary: null, raw, error: `malformed JSON: ${err.message}` }
  }
  const v = validateReview(parsed)
  if (!v.ok) return { ok: false, findings: [], summary: null, raw, error: v.error }
  return { ok: true, findings: v.findings, summary: parsed.summary ?? null, raw, error: null }
}
```

- [ ] **Step 7: Write `scripts/lib/render.mjs`**

```js
import { SEVERITIES } from './review-schema.mjs'

export function formatElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function renderReview(parsed, { scope, base, truncated, jobId }) {
  const lines = []
  const scopeLabel = scope === 'branch' ? `branch diff vs ${base}` : 'working tree'
  lines.push(`opencode review — ${scopeLabel} (${jobId})`)
  if (truncated) lines.push('Note: the diff was truncated before it was sent; findings may be incomplete.')
  lines.push('')

  if (!parsed.ok) {
    lines.push(`The model's output could not be parsed as review JSON (${parsed.error}).`)
    lines.push('Raw output follows verbatim:')
    lines.push('')
    lines.push(parsed.raw ?? '(empty)')
    return lines.join('\n')
  }

  if (parsed.summary) { lines.push(parsed.summary); lines.push('') }

  if (parsed.findings.length === 0) {
    lines.push('No findings.')
    return lines.join('\n')
  }

  const sorted = [...parsed.findings].sort(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
  for (const f of sorted) {
    const where = f.line ? `${f.file}:${f.line}` : f.file
    const title = f.title ? ` — ${f.title}` : ''
    lines.push(`[${f.severity.toUpperCase()}] (${f.confidence} confidence) ${where}${title}`)
    for (const l of f.body.split('\n')) lines.push(`    ${l}`)
    lines.push('')
  }
  lines.push(`${sorted.length} finding${sorted.length === 1 ? '' : 's'}.`)
  return lines.join('\n')
}

export function renderJobList(jobs, now = Date.now()) {
  if (!jobs.length) return 'No opencode jobs for this Claude Code session.'
  const lines = ['opencode jobs for this session:', '']
  for (const j of jobs) {
    const elapsed = formatElapsed((j.endedAt ?? now) - j.startedAt)
    const c = j.counters ?? {}
    const counters = [
      c.steps ? `${c.steps} steps` : null,
      c.tools ? `${c.tools} tools` : null,
      (c.inputTokens || c.outputTokens) ? `${c.inputTokens ?? 0}in/${c.outputTokens ?? 0}out tokens` : null,
    ].filter(Boolean).join(', ')
    lines.push(`  ${j.id}  ${j.verb.padEnd(8)} ${j.state.padEnd(9)} ${elapsed.padStart(7)}${counters ? '  ' + counters : ''}`)
    if (j.error) lines.push(`      error: ${j.error}`)
  }
  return lines.join('\n')
}

export function renderJobResult(job, resultText) {
  const head = `opencode ${job.verb} ${job.id} — ${job.state}`
  if (job.state === 'running') {
    const body = resultText && resultText.trim()
      ? resultText
      : '(no output yet — the job has not produced text)'
    return [head, 'This job is still running; the output below is a partial tail.', '', body].join('\n')
  }
  if (!resultText || !resultText.trim()) {
    return [head, '', '(no output was produced)'].join('\n')
  }
  return [head, '', resultText].join('\n')
}

export function renderDoctor(report) {
  const mark = (ok) => (ok ? 'ok  ' : 'GAP ')
  const lines = ['opencode doctor', '']
  lines.push(`${mark(report.binary.ok)} binary      ${report.binary.path ?? 'not found'}${report.binary.source ? ` (via ${report.binary.source})` : ''}`)
  lines.push(`${mark(report.version.ok)} version     ${report.version.value ?? 'unknown'} (floor ${report.version.floor})`)
  lines.push(`${mark(report.auth.ok)} auth        ${report.auth.providers.length ? report.auth.providers.join(', ') : 'no providers configured'}`)
  lines.push(`${mark(report.model.ok)} model       ${report.model.value ?? 'no default model'}${report.model.source ? ` (${report.model.source}: ${report.model.path})` : ''}`)
  lines.push(`${mark(report.server.ok)} server      ${report.server.detail}`)
  lines.push('')
  if (report.ok) lines.push('All checks passed.')
  else {
    lines.push('Gaps:')
    for (const g of report.gaps) lines.push(`  - ${g}`)
    lines.push('')
    lines.push('Run /opencode:setup to fix these.')
  }
  return lines.join('\n')
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test tests/unit/prompts.test.mjs tests/unit/review-schema.test.mjs tests/unit/render.test.mjs`
Expected: PASS, 25 tests

- [ ] **Step 9: Commit**

```bash
git add prompts schemas scripts/lib/prompts.mjs scripts/lib/review-schema.mjs scripts/lib/render.mjs tests/unit/prompts.test.mjs tests/unit/review-schema.test.mjs tests/unit/render.test.mjs
git commit -m "feat: review prompts, output schema, tolerant parsing, and rendering"
```

---

## Task 12: `scripts/opencode-companion.mjs` — entrypoint, dispatch, and `doctor`

Every other command calls `doctor` first and stops with a specific gap rather
than a stack trace.

**Files:**
- Create: `scripts/opencode-companion.mjs`, `scripts/lib/doctor.mjs`
- Test: `tests/integration/doctor.test.mjs`, `tests/integration/companion-dispatch.test.mjs`

**Interfaces:**
- Consumes: `parseArgs` (`lib/args.mjs`); `resolveBinary`, `binaryVersion`, `meetsFloor`, `MIN_VERSION` (`lib/opencode.mjs`); `listProviders`, `envProviderHints` (`lib/credentials.mjs`); `resolveDefaultModel` (`lib/config.mjs`); `ensureBroker`, `shutdownBroker` (`lib/broker-lifecycle.mjs`); `renderDoctor` (`lib/render.mjs`).
- Produces (`doctor.mjs`):
  - `runDoctor({env?, cwd?, checkServer = true}): Promise<DoctorReport>` where
    ```
    DoctorReport = {
      ok: boolean,
      gaps: string[],
      binary: {ok, path: string|null, source: string|null, error: string|null},
      version: {ok, value: string|null, floor: string},
      auth: {ok, providers: string[], envHints: Array<{provider, envVar}>},
      model: {ok, value: string|null, source: 'project'|'global'|null, path: string|null},
      server: {ok, detail: string}
    }
    ```
    Checks run in ladder order and short-circuit: a failed binary check marks every later check `ok: false` with `detail: 'not checked'`.
  - `requireReady(report, {need = ['binary','version','auth','model']}): void` — throws `CompanionError` naming the first gap plus `Run /opencode:setup.`
- Produces (companion entrypoint):
  - `class CompanionError extends Error { exitCode = 1 }` exported from `lib/doctor.mjs`
  - CLI contract: `opencode-companion.mjs <verb> [flags]`; `--json` on `doctor` prints the report as JSON; unknown verbs exit 2 with a usage line on stderr listing every implemented verb; `--help` prints the same usage to stdout and exits 0
  - `VERBS: string[]` exported from the entrypoint via `export const VERBS` so `tests/lint-commands.test.mjs` can read it without executing the CLI

- [ ] **Step 1: Write the failing doctor test**

Create `tests/integration/doctor.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDoctor, requireReady, CompanionError } from '../../scripts/lib/doctor.mjs'
import { shutdownBroker } from '../../scripts/lib/broker-lifecycle.mjs'
import { clearBinaryCache } from '../../scripts/lib/opencode.mjs'

const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))

async function sandbox(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ocdoc-'))
  const env = {
    PATH: '/nonexistent',
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: fixture,
    ...extra,
  }
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  return { env, cwd: home }
}

test('a fully configured environment reports ok', async () => {
  clearBinaryCache()
  const s = await sandbox()
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  await writeFile(join(s.env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"openrouter/x"}')
  const r = await runDoctor({ env: s.env, cwd: s.cwd })
  assert.equal(r.ok, true, JSON.stringify(r.gaps))
  assert.equal(r.binary.source, 'env')
  assert.equal(r.model.source, 'global')
  await shutdownBroker(s.env)
})

test('a missing binary short-circuits every later check', async () => {
  clearBinaryCache()
  const s = await sandbox({ OPENCODE_BIN: '/nonexistent/opencode' })
  const r = await runDoctor({ env: s.env, cwd: s.cwd })
  assert.equal(r.binary.ok, false)
  assert.equal(r.version.ok, false)
  assert.equal(r.server.detail, 'not checked')
  assert.match(r.gaps[0], /binary/i)
})

test('an out-of-date binary is a version gap, not a binary gap', async () => {
  clearBinaryCache()
  const s = await sandbox({ FAKE_OPENCODE_FAULT: 'old-version' })
  const r = await runDoctor({ env: s.env, cwd: s.cwd, checkServer: false })
  assert.equal(r.binary.ok, true)
  assert.equal(r.version.ok, false)
  assert.equal(r.version.value, '1.17.0')
  assert.match(r.gaps.join(' '), /1\.18\.0/)
})

test('no auth.json is an auth gap and env hints are surfaced', async () => {
  clearBinaryCache()
  const s = await sandbox({ ANTHROPIC_API_KEY: 'sk-test' })
  const r = await runDoctor({ env: s.env, cwd: s.cwd, checkServer: false })
  assert.equal(r.auth.ok, false)
  assert.deepEqual(r.auth.envHints.map(h => h.provider), ['anthropic'])
})

test('auth present but no model is exactly one gap', async () => {
  clearBinaryCache()
  const s = await sandbox()
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  const r = await runDoctor({ env: s.env, cwd: s.cwd, checkServer: false })
  assert.equal(r.auth.ok, true)
  assert.equal(r.model.ok, false)
  assert.equal(r.gaps.length, 1)
  assert.match(r.gaps[0], /model/i)
})

test('a project opencode.json beats the global config in the report', async () => {
  clearBinaryCache()
  const s = await sandbox()
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  await writeFile(join(s.env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"global/m"}')
  await writeFile(join(s.cwd, 'opencode.json'), '{"model":"project/m"}')
  const r = await runDoctor({ env: s.env, cwd: s.cwd, checkServer: false })
  assert.equal(r.model.value, 'project/m')
  assert.equal(r.model.source, 'project')
})

test('requireReady throws a CompanionError naming the gap', () => {
  const report = { ok: false, gaps: ['no default model is configured'], binary: { ok: true }, version: { ok: true }, auth: { ok: true }, model: { ok: false }, server: { ok: true } }
  assert.throws(() => requireReady(report), (e) => e instanceof CompanionError && /no default model/.test(e.message) && /\/opencode:setup/.test(e.message))
})

test('requireReady passes when the needed checks are ok', () => {
  const report = { ok: false, gaps: ['server unreachable'], binary: { ok: true }, version: { ok: true }, auth: { ok: true }, model: { ok: true }, server: { ok: false } }
  requireReady(report, { need: ['binary', 'version', 'auth', 'model'] })
})
```

- [ ] **Step 2: Write the failing dispatch test**

Create `tests/integration/companion-dispatch.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'

const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))

async function env(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'occli-'))
  const e = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: fixture,
    CLAUDE_SESSION_ID: 'cc-test',
    ...extra,
  }
  await mkdir(join(e.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(e.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  await writeFile(join(e.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  await writeFile(join(e.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"openrouter/x"}')
  return { env: e, home }
}

test('--help exits 0 and lists the verbs', async () => {
  const e = await env()
  const r = await run(process.execPath, [companion, '--help'], { env: e.env })
  assert.equal(r.code, 0)
  for (const v of ['doctor', 'review', 'task', 'status', 'result', 'cancel', 'transfer', 'set-key', 'set-model']) {
    assert.match(r.stdout, new RegExp(`\\b${v}\\b`), v)
  }
})

test('an unknown verb exits 2 with usage on stderr', async () => {
  const e = await env()
  const r = await run(process.execPath, [companion, 'frobnicate'], { env: e.env })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /unknown verb: frobnicate/)
  assert.equal(r.stdout, '')
})

test('doctor --json emits a parseable report and exits 0 when ready', async () => {
  const e = await env()
  const r = await run(process.execPath, [companion, 'doctor', '--json'], { env: e.env })
  assert.equal(r.code, 0)
  const report = JSON.parse(r.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.model.value, 'openrouter/x')
})

test('doctor --json exits 1 but still emits the report when a gap exists', async () => {
  const e = await env({ OPENCODE_BIN: '/nonexistent/opencode' })
  const r = await run(process.execPath, [companion, 'doctor', '--json'], { env: e.env })
  assert.equal(r.code, 1)
  const report = JSON.parse(r.stdout)
  assert.equal(report.ok, false)
  assert.ok(report.gaps.length > 0)
})

test('doctor without --json renders a readable table', async () => {
  const e = await env()
  const r = await run(process.execPath, [companion, 'doctor'], { env: e.env })
  assert.match(r.stdout, /opencode doctor/)
  assert.match(r.stdout, /binary/)
  assert.match(r.stdout, /All checks passed/)
})

test('a verb blocked by a gap names the gap and points at setup', async () => {
  const e = await env({ OPENCODE_BIN: '/nonexistent/opencode' })
  const r = await run(process.execPath, [companion, 'status'], { env: e.env })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /\/opencode:setup/)
})
```

- [ ] **Step 3: Run both to verify they fail**

Run: `node --test tests/integration/doctor.test.mjs tests/integration/companion-dispatch.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/lib/doctor.mjs'`

- [ ] **Step 4: Write `scripts/lib/doctor.mjs`**

```js
import { resolveBinary, binaryVersion, meetsFloor, MIN_VERSION } from './opencode.mjs'
import { listProviders, envProviderHints } from './credentials.mjs'
import { resolveDefaultModel } from './config.mjs'
import { ensureBroker } from './broker-lifecycle.mjs'

export class CompanionError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'CompanionError'
    this.exitCode = exitCode
  }
}

export async function runDoctor({ env = process.env, cwd = process.cwd(), checkServer = true } = {}) {
  const report = {
    ok: false,
    gaps: [],
    binary: { ok: false, path: null, source: null, error: null },
    version: { ok: false, value: null, floor: MIN_VERSION },
    auth: { ok: false, providers: [], envHints: [] },
    model: { ok: false, value: null, source: null, path: null },
    server: { ok: false, detail: 'not checked' },
  }

  try {
    const bin = await resolveBinary({ env })
    report.binary = { ok: true, path: bin.path, source: bin.source, error: null }
  } catch (err) {
    report.binary.error = err.message
    report.gaps.push('the opencode binary was not found')
    return report
  }

  try {
    const version = await binaryVersion(report.binary.path)
    report.version = { ok: meetsFloor(version), value: version, floor: MIN_VERSION }
    if (!report.version.ok) report.gaps.push(`opencode ${version} is older than the required ${MIN_VERSION}`)
  } catch (err) {
    report.gaps.push(`could not read the opencode version: ${err.message}`)
    return report
  }

  report.auth.providers = await listProviders(env)
  report.auth.envHints = await envProviderHints(env)
  report.auth.ok = report.auth.providers.length > 0
  if (!report.auth.ok) report.gaps.push('no opencode provider credentials are configured')

  const model = await resolveDefaultModel({ env, cwd })
  if (model) report.model = { ok: true, value: model.model, source: model.source, path: model.path }
  else report.gaps.push('no default model is configured')

  if (checkServer) {
    try {
      const broker = await ensureBroker({ env })
      report.server = { ok: true, detail: `reachable at ${broker.baseUrl}` }
    } catch (err) {
      report.server = { ok: false, detail: err.message }
      report.gaps.push(`the opencode server would not start: ${err.message}`)
    }
  }

  report.ok = report.gaps.length === 0
  return report
}

export function requireReady(report, { need = ['binary', 'version', 'auth', 'model'] } = {}) {
  for (const key of need) {
    if (report[key]?.ok) continue
    const gap = report.gaps[0] ?? `the ${key} check did not pass`
    throw new CompanionError(`opencode is not ready: ${gap}. Run /opencode:setup.`)
  }
}
```

- [ ] **Step 5: Write `scripts/opencode-companion.mjs` with the doctor verb only**

Later tasks add verbs to `handlers`. Keep the dispatch table as the single source
of truth for `VERBS`.

```js
#!/usr/bin/env node
import { parseArgs } from './lib/args.mjs'
import { runDoctor, requireReady, CompanionError } from './lib/doctor.mjs'
import { renderDoctor } from './lib/render.mjs'

const handlers = {
  doctor: async ({ flags, env, cwd }) => {
    const report = await runDoctor({ env, cwd, checkServer: flags.server !== false })
    const out = flags.json ? JSON.stringify(report, null, 2) : renderDoctor(report)
    return { stdout: out, exitCode: report.ok ? 0 : 1 }
  },
}

export const VERBS = Object.keys(handlers)

function usage() {
  return [
    'opencode-companion.mjs <verb> [flags]',
    '',
    'Verbs:',
    ...VERBS.map(v => `  ${v}`),
    '',
    'Flags are verb-specific; see the /opencode:* command definitions.',
  ].join('\n')
}

export function ccSessionId(env = process.env) {
  return env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || 'default'
}

async function main(argv, env = process.env, cwd = process.cwd()) {
  const { verb, flags, positional } = parseArgs(argv)
  if (!verb || flags.help) {
    process.stdout.write(usage() + '\n')
    return 0
  }
  const handler = handlers[verb]
  if (!handler) {
    process.stderr.write(`unknown verb: ${verb}\n\n${usage()}\n`)
    return 2
  }
  try {
    const res = await handler({ flags, positional, env, cwd, ccSessionId: ccSessionId(env) })
    if (res?.stdout) process.stdout.write(res.stdout.endsWith('\n') ? res.stdout : res.stdout + '\n')
    return res?.exitCode ?? 0
  } catch (err) {
    process.stderr.write((err instanceof CompanionError ? err.message : `opencode-plugin-cc: ${err.stack || err.message}`) + '\n')
    return err.exitCode ?? 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2))
}

export { main, handlers, usage }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/integration/doctor.test.mjs tests/integration/companion-dispatch.test.mjs`
Expected: the doctor tests PASS (8). The dispatch tests FAIL on `--help` listing
verbs that do not exist yet and on `status` not existing.

- [ ] **Step 7: Narrow the dispatch test to the verbs that exist now**

Change the `--help` assertion list in `tests/integration/companion-dispatch.test.mjs` to `['doctor']` and delete the `status` test, replacing it with:

```js
test('a verb blocked by a gap names the gap and points at setup', async () => {
  const e = await env({ OPENCODE_BIN: '/nonexistent/opencode' })
  const r = await run(process.execPath, [companion, 'doctor'], { env: e.env })
  assert.equal(r.code, 1)
  assert.match(r.stdout, /Run \/opencode:setup/)
})
```

Task 17 restores the full verb list once every verb is implemented.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test tests/integration/doctor.test.mjs tests/integration/companion-dispatch.test.mjs`
Expected: PASS, 13 tests

- [ ] **Step 9: Commit**

```bash
git add scripts/opencode-companion.mjs scripts/lib/doctor.mjs tests/integration/doctor.test.mjs tests/integration/companion-dispatch.test.mjs
git commit -m "feat: companion entrypoint with the doctor preflight ladder"
```

---

## Task 13: Setup verbs — `set-key`, `set-model`, `gate`, `repair`, `models`

**Files:**
- Modify: `scripts/opencode-companion.mjs` (add five handlers)
- Create: `scripts/lib/gate.mjs`
- Test: `tests/integration/setup-verbs.test.mjs`

**Interfaces:**
- Consumes: `setKey` (`lib/credentials.mjs`); `setModel`, `resolveDefaultModel` (`lib/config.mjs`); `resolveBinary` (`lib/opencode.mjs`); `run` (`lib/process.mjs`); `reapOrphans`, `shutdownBroker` (`lib/broker-lifecycle.mjs`); `pruneStale` (`lib/tracked-jobs.mjs`); `runDoctor`, `renderDoctor`.
- Produces (`gate.mjs`):
  - `gateStatePath(env?): string` — `<stateRoot>/gate.json`
  - `readGate(env?): Promise<boolean>` — default `false`
  - `writeGate(on: boolean, env?): Promise<void>`
- Produces (new companion verbs):
  - `set-key --provider <p> --key <k>` — calls `setKey`, prints `Stored a key for <provider> (****1234) in <path>. Backed up the previous file to <path>.bak.` then re-runs `doctor` (no server check) and appends the rendered report. Never prints the key.
  - `set-model --model <provider/model> [--scope global|project]` — default scope `global`; prints the written path and the re-run doctor report.
  - `models [--provider <p>]` — runs `opencode models`, filters by `provider/` prefix when given, prints one per line. Exits 1 with the binary's stderr if it fails.
  - `gate [--on|--off|--status]` — reads/writes the gate flag; `--status` prints `on` or `off`.
  - `repair` — `reapOrphans` + `pruneStale`, prints what was cleared.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/setup-verbs.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'

const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))

async function sandbox(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ocsetup-'))
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: fixture,
    CLAUDE_SESSION_ID: 'cc-setup',
    ...extra,
  }
  await mkdir(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  return { env, home }
}

const cli = (env, args, cwd) => run(process.execPath, [companion, ...args], { env, cwd })

test('set-key writes auth.json at 0600 and prints only a redacted confirmation', async () => {
  const s = await sandbox()
  const r = await cli(s.env, ['set-key', '--provider', 'openrouter', '--key', 'sk-or-abcd1234'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /\*\*\*\*1234/)
  assert.equal(r.stdout.includes('sk-or-abcd1234'), false)
  const p = join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json')
  assert.equal(JSON.parse(await readFile(p, 'utf8')).openrouter.key, 'sk-or-abcd1234')
  assert.equal((await stat(p)).mode & 0o777, 0o600)
})

test('set-key preserves an existing provider', async () => {
  const s = await sandbox()
  await mkdir(join(s.env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"anthropic":{"type":"api","key":"KEEP"}}')
  await cli(s.env, ['set-key', '--provider', 'openrouter', '--key', 'sk-or-wxyz9876'])
  const out = JSON.parse(await readFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), 'utf8'))
  assert.equal(out.anthropic.key, 'KEEP')
})

test('set-key without a key exits non-zero with a clear message', async () => {
  const s = await sandbox()
  const r = await cli(s.env, ['set-key', '--provider', 'openrouter'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /--key/)
})

test('set-model merges into the existing global .jsonc and re-runs doctor', async () => {
  const s = await sandbox()
  await mkdir(join(s.env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  const cfg = join(s.env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc')
  await writeFile(cfg, '{\n  // keep\n  "theme": "dark"\n}')
  const r = await cli(s.env, ['set-model', '--model', 'openrouter/x'])
  assert.equal(r.code, 0)
  const out = JSON.parse(await readFile(cfg, 'utf8'))
  assert.equal(out.theme, 'dark')
  assert.equal(out.model, 'openrouter/x')
  assert.match(r.stdout, /opencode doctor/)
})

test('set-model --scope project writes into the working directory', async () => {
  const s = await sandbox()
  const r = await cli(s.env, ['set-model', '--model', 'openrouter/y', '--scope', 'project'], s.home)
  assert.equal(r.code, 0)
  const out = JSON.parse(await readFile(join(s.home, 'opencode.json'), 'utf8'))
  assert.equal(out.model, 'openrouter/y')
  assert.equal(out.$schema, 'https://opencode.ai/config.json')
})

test('set-model rejects a model without a provider prefix', async () => {
  const s = await sandbox()
  const r = await cli(s.env, ['set-model', '--model', 'justamodel'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /provider\/model/)
})

test('models lists what the binary reports and filters by provider', async () => {
  const s = await sandbox({ FAKE_OPENCODE_MODELS: 'a/one,a/two,b/three' })
  const all = await cli(s.env, ['models'])
  assert.deepEqual(all.stdout.trim().split('\n'), ['a/one', 'a/two', 'b/three'])
  const filtered = await cli(s.env, ['models', '--provider', 'a'])
  assert.deepEqual(filtered.stdout.trim().split('\n'), ['a/one', 'a/two'])
})

test('the gate is off by default and toggles', async () => {
  const s = await sandbox()
  assert.match((await cli(s.env, ['gate', '--status'])).stdout, /off/)
  await cli(s.env, ['gate', '--on'])
  assert.match((await cli(s.env, ['gate', '--status'])).stdout, /on/)
  await cli(s.env, ['gate', '--off'])
  assert.match((await cli(s.env, ['gate', '--status'])).stdout, /off/)
})

test('repair clears a stale portfile and reports it', async () => {
  const s = await sandbox()
  const brokerDir = join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'broker')
  await mkdir(brokerDir, { recursive: true })
  await writeFile(join(brokerDir, 'port.json'), JSON.stringify({ port: 1, pid: 2 ** 22, password: 'p', startedAt: 0 }))
  const r = await cli(s.env, ['repair'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /broker/i)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/integration/setup-verbs.test.mjs`
Expected: FAIL — `unknown verb: set-key`

- [ ] **Step 3: Write `scripts/lib/gate.mjs`**

```js
import { join } from 'node:path'
import { stateRoot, readJson, writeJson } from './state.mjs'

export const gateStatePath = (env = process.env) => join(stateRoot(env), 'gate.json')

export async function readGate(env = process.env) {
  return (await readJson(gateStatePath(env), { on: false })).on === true
}

export async function writeGate(on, env = process.env) {
  await writeJson(gateStatePath(env), { on: Boolean(on), updatedAt: Date.now() })
}
```

- [ ] **Step 4: Add the five handlers to `scripts/opencode-companion.mjs`**

Add these imports at the top:

```js
import { setKey } from './lib/credentials.mjs'
import { setModel } from './lib/config.mjs'
import { readGate, writeGate } from './lib/gate.mjs'
import { resolveBinary } from './lib/opencode.mjs'
import { run } from './lib/process.mjs'
import { reapOrphans } from './lib/broker-lifecycle.mjs'
import { pruneStale } from './lib/tracked-jobs.mjs'
```

Add these entries to `handlers`:

```js
  'set-key': async ({ flags, env, cwd }) => {
    if (!flags.provider || flags.provider === true) throw new CompanionError('set-key requires --provider <name>')
    if (!flags.key || flags.key === true) throw new CompanionError('set-key requires --key <API_KEY>')
    const res = await setKey({ provider: flags.provider, key: String(flags.key), env })
    const lines = [`Stored a key for ${res.provider} (${res.redacted}) in ${res.path}.`]
    if (res.backup) lines.push(`Backed up the previous file to ${res.backup}.`)
    const report = await runDoctor({ env, cwd, checkServer: false })
    lines.push('', renderDoctor(report))
    return { stdout: lines.join('\n'), exitCode: 0 }
  },

  'set-model': async ({ flags, env, cwd }) => {
    if (!flags.model || flags.model === true) throw new CompanionError('set-model requires --model <provider/model>')
    const scope = flags.scope === 'project' ? 'project' : 'global'
    let res
    try {
      res = await setModel({ model: String(flags.model), scope, env, cwd })
    } catch (err) {
      throw new CompanionError(err.message)
    }
    const lines = [`Set the default model to ${flags.model} in ${res.path} (${scope} scope).`]
    if (res.backup) lines.push(`Backed up the previous file to ${res.backup}.`)
    const report = await runDoctor({ env, cwd, checkServer: false })
    lines.push('', renderDoctor(report))
    return { stdout: lines.join('\n'), exitCode: report.model.ok ? 0 : 1 }
  },

  models: async ({ flags, env }) => {
    const bin = await resolveBinary({ env })
    const r = await run(bin.path, ['models'], { env, timeoutMs: 60000 })
    if (r.code !== 0) throw new CompanionError(`opencode models failed:\n${r.stderr.trim()}`)
    let lines = r.stdout.split('\n').map(l => l.trim()).filter(Boolean)
    if (flags.provider && flags.provider !== true) {
      lines = lines.filter(l => l.startsWith(`${flags.provider}/`))
    }
    return { stdout: lines.join('\n'), exitCode: 0 }
  },

  gate: async ({ flags, env }) => {
    if (flags.on) await writeGate(true, env)
    else if (flags.off) await writeGate(false, env)
    const on = await readGate(env)
    return { stdout: `The Stop review gate is ${on ? 'on' : 'off'}.`, exitCode: 0 }
  },

  repair: async ({ env }) => {
    const broker = await reapOrphans(env)
    const jobs = await pruneStale(env)
    const lines = [
      broker.cleared ? 'Cleared a stale broker portfile.' : 'The broker record was already clean.',
      jobs.stale.length ? `Marked ${jobs.stale.length} orphaned job record(s) stale: ${jobs.stale.join(', ')}` : 'No orphaned job records.',
      jobs.removed.length ? `Removed ${jobs.removed.length} expired job record(s).` : 'No expired job records.',
    ]
    return { stdout: lines.join('\n'), exitCode: 0 }
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/integration/setup-verbs.test.mjs`
Expected: PASS, 9 tests

- [ ] **Step 6: Commit**

```bash
git add scripts/opencode-companion.mjs scripts/lib/gate.mjs tests/integration/setup-verbs.test.mjs
git commit -m "feat: set-key, set-model, models, gate, and repair companion verbs"
```

---

## Task 14: `review` and `adversarial-review` verbs, plus the review agent

**Files:**
- Modify: `scripts/opencode-companion.mjs`
- Create: `scripts/lib/review-job.mjs`, `agents/opencode-review.md`
- Test: `tests/integration/review-verb.test.mjs`

**Interfaces:**
- Consumes: `resolveScope`, `sizeChange`, `collectDiff`, `repoRoot` (`lib/git.mjs`); `loadPrompt` (`lib/prompts.mjs`); `startJob`, `runForeground` (`lib/job-control.mjs`); `readResult` (`lib/tracked-jobs.mjs`); `parseReviewOutput` (`lib/review-schema.mjs`); `renderReview` (`lib/render.mjs`); `runDoctor`, `requireReady`.
- Produces (`review-job.mjs`):
  - `REVIEW_AGENT = 'opencode-review'`
  - `REVIEW_TOOLS = {read: true, grep: true, glob: true, list: true, edit: false, write: false, patch: false, bash: false, webfetch: false}` — passed as `tools` on `prompt_async` so auto-approval cannot grant write or shell even if the agent file is missing
  - `prepareReview({cwd, scope, base, adversarial, focus}): Promise<{prompt, scope, base, size, truncated}>` — resolves scope, sizes, refuses with a `CompanionError` when `size.empty`, collects the diff, and loads the right template
  - `finishReview({jobId, env}): Promise<string>` — reads `result.md`, parses, renders
- Produces (companion verbs):
  - `review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model m] [--variant v]`
  - `adversarial-review` — same flags plus free-form focus text in `positional`
  - `review-size --json` — a size-only probe the command markdown calls before deciding wait vs background: prints `{"scope","base","files","insertions","deletions","untracked","empty","tiny"}`
  - Foreground (`--wait`, the default when neither flag is given at the CLI layer) prints the rendered review. Background prints `Started <verb> as <jobId>. Check it with /opencode:status, read it with /opencode:result <jobId>.` and exits 0 immediately.

- [ ] **Step 1: Write `agents/opencode-review.md`**

An opencode agent definition, installed by the user's opencode config or shipped
for reference. It denies write tools so auto-approval grants nothing dangerous.

```markdown
---
description: Read-only reviewer used by opencode-plugin-cc. Reports defects; never edits.
mode: subagent
tools:
  read: true
  grep: true
  glob: true
  list: true
  edit: false
  write: false
  patch: false
  bash: false
  webfetch: false
---

You review code changes and report defects. You never modify files and never run
shell commands. The change under review is supplied in the prompt; use read only
to see surrounding context in files the change touches. Respond with the JSON
object the prompt specifies and nothing else.
```

- [ ] **Step 2: Write the failing test**

Create `tests/integration/review-verb.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'

const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))

async function repoSandbox(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ocrev-'))
  const repo = join(home, 'repo')
  await mkdir(repo, { recursive: true })
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: fixture,
    CLAUDE_SESSION_ID: 'cc-review',
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
    ...extra,
  }
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  await writeFile(join(env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  await writeFile(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"openrouter/x"}')
  const git = (...a) => run('git', a, { cwd: repo, env })
  await git('init', '-b', 'main')
  await writeFile(join(repo, 'a.js'), 'let x = 1\n')
  await git('add', '.')
  await git('commit', '-m', 'init')
  return { env, repo, git }
}

const cli = (env, cwd, args) => run(process.execPath, [companion, ...args], { env, cwd, timeoutMs: 60000 })

test('review-size reports an empty clean tree', async () => {
  const s = await repoSandbox()
  const r = await cli(s.env, s.repo, ['review-size', '--json'])
  assert.equal(r.code, 0)
  const size = JSON.parse(r.stdout)
  assert.equal(size.empty, true)
  assert.equal(size.scope, 'working-tree')
})

test('review-size counts untracked files as reviewable work', async () => {
  const s = await repoSandbox()
  await writeFile(join(s.repo, 'new.js'), 'const y = 2\n')
  const size = JSON.parse((await cli(s.env, s.repo, ['review-size', '--json'])).stdout)
  assert.equal(size.empty, false)
  assert.deepEqual(size.untracked, ['new.js'])
  assert.equal(size.tiny, true)
})

test('review --wait renders parsed findings', async () => {
  const s = await repoSandbox()
  await writeFile(join(s.repo, 'a.js'), 'let x = 1\nlet z = null.foo\n')
  const r = await cli(s.env, s.repo, ['review', '--wait'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /opencode review/)
  assert.match(r.stdout, /HIGH/)
  assert.match(r.stdout, /Null deref/)
})

test('review refuses when there is nothing to review', async () => {
  const s = await repoSandbox()
  const r = await cli(s.env, s.repo, ['review', '--wait'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /nothing to review/i)
})

test('review --background returns a job id immediately', async () => {
  const s = await repoSandbox({ FAKE_OPENCODE_EVENT_DELAY_MS: '150' })
  await writeFile(join(s.repo, 'a.js'), 'let x = 2\n')
  const r = await cli(s.env, s.repo, ['review', '--background'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /job_[a-z0-9]+/)
  assert.match(r.stdout, /\/opencode:result/)
})

test('unparseable model output is rendered raw, never discarded', async () => {
  const s = await repoSandbox({ FAKE_OPENCODE_FAULT: 'malformed-json' })
  await writeFile(join(s.repo, 'a.js'), 'let x = 3\n')
  const r = await cli(s.env, s.repo, ['review', '--wait'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /could not be parsed/i)
  assert.match(r.stdout, /not json at all/)
})

test('review blocks with a setup pointer when no model is configured', async () => {
  const s = await repoSandbox()
  await writeFile(join(s.env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{}')
  await writeFile(join(s.repo, 'a.js'), 'let x = 4\n')
  const r = await cli(s.env, s.repo, ['review', '--wait'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /no default model/)
  assert.match(r.stderr, /\/opencode:setup/)
})

test('adversarial-review accepts focus text and still renders findings', async () => {
  const s = await repoSandbox()
  await writeFile(join(s.repo, 'a.js'), 'let x = 5\n')
  const r = await cli(s.env, s.repo, ['adversarial-review', '--wait', '--', 'is the retry loop sound?'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /opencode review/)
})

test('review --scope branch diffs against the base', async () => {
  const s = await repoSandbox()
  await s.git('branch', 'base-ref')
  await writeFile(join(s.repo, 'b.js'), 'const b = 1\n')
  await s.git('add', '.')
  await s.git('commit', '-m', 'second')
  const r = await cli(s.env, s.repo, ['review', '--wait', '--scope', 'branch', '--base', 'base-ref'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /branch diff vs base-ref/)
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test tests/integration/review-verb.test.mjs`
Expected: FAIL — `unknown verb: review-size`

- [ ] **Step 4: Write `scripts/lib/review-job.mjs`**

```js
import { resolveScope, sizeChange, collectDiff, repoRoot } from './git.mjs'
import { loadPrompt } from './prompts.mjs'
import { readResult } from './tracked-jobs.mjs'
import { parseReviewOutput } from './review-schema.mjs'
import { renderReview } from './render.mjs'
import { CompanionError } from './doctor.mjs'

export const REVIEW_AGENT = 'opencode-review'

export const REVIEW_TOOLS = {
  read: true, grep: true, glob: true, list: true,
  edit: false, write: false, patch: false, bash: false, webfetch: false,
}

export async function prepareReview({ cwd, scope = 'auto', base, adversarial = false, focus = '' }) {
  const root = await repoRoot(cwd).catch(() => { throw new CompanionError(`not a git repository: ${cwd}`) })
  const resolved = await resolveScope({ cwd: root, scope, base })
  const size = await sizeChange({ cwd: root, scope: resolved.scope, base: resolved.base })
  if (size.empty) {
    throw new CompanionError(
      `There is nothing to review: the ${resolved.scope === 'branch' ? `branch diff against ${resolved.base}` : 'working tree'} is empty.`
    )
  }
  const diff = await collectDiff({ cwd: root, scope: resolved.scope, base: resolved.base })
  const vars = {
    CWD: root,
    SCOPE: resolved.scope,
    BASE_NOTE: resolved.base ? ` (against ${resolved.base})` : '',
    DIFF: diff.text,
  }
  const prompt = adversarial
    ? await loadPrompt('adversarial-review', { ...vars, FOCUS: focus.trim() || '(none given)' })
    : await loadPrompt('review', vars)
  return { prompt, root, scope: resolved.scope, base: resolved.base, size, truncated: diff.truncated }
}

export async function finishReview({ jobId, env, scope, base, truncated }) {
  const text = await readResult(jobId, env)
  const parsed = parseReviewOutput(text ?? '')
  return renderReview(parsed, { scope, base, truncated, jobId })
}
```

- [ ] **Step 5: Add the three verbs to `scripts/opencode-companion.mjs`**

Imports:

```js
import { prepareReview, finishReview, REVIEW_AGENT, REVIEW_TOOLS } from './lib/review-job.mjs'
import { startJob } from './lib/job-control.mjs'
import { resolveScope, sizeChange, repoRoot } from './lib/git.mjs'
```

Handlers:

```js
  'review-size': async ({ flags, env, cwd }) => {
    const root = await repoRoot(cwd).catch(() => { throw new CompanionError(`not a git repository: ${cwd}`) })
    const resolved = await resolveScope({ cwd: root, scope: flags.scope || 'auto', base: flags.base })
    const size = await sizeChange({ cwd: root, scope: resolved.scope, base: resolved.base })
    const payload = { scope: resolved.scope, base: resolved.base, ...size }
    return { stdout: flags.json ? JSON.stringify(payload, null, 2) : JSON.stringify(payload), exitCode: 0 }
  },

  review: (ctx) => reviewVerb(ctx, { adversarial: false }),
  'adversarial-review': (ctx) => reviewVerb(ctx, { adversarial: true }),
```

And this function above `handlers`:

```js
async function reviewVerb({ flags, positional, env, cwd, ccSessionId }, { adversarial }) {
  const report = await runDoctor({ env, cwd, checkServer: false })
  requireReady(report)

  const prep = await prepareReview({
    cwd,
    scope: flags.scope || 'auto',
    base: flags.base,
    adversarial,
    focus: positional.join(' '),
  })

  const verb = adversarial ? 'adversarial-review' : 'review'
  const jobOpts = {
    ccSessionId,
    verb,
    prompt: prep.prompt,
    agent: REVIEW_AGENT,
    tools: REVIEW_TOOLS,
    model: flags.model && flags.model !== true ? String(flags.model) : undefined,
    variant: (flags.variant ?? flags.effort) && flags.variant !== true ? String(flags.variant ?? flags.effort) : undefined,
    cwd: prep.root,
    env,
  }

  if (flags.background) {
    const { jobId } = await startJob(jobOpts)
    return {
      stdout: `Started ${verb} as ${jobId}. Check it with /opencode:status, read it with /opencode:result ${jobId}.`,
      exitCode: 0,
    }
  }

  const { jobId, done } = await startJob(jobOpts)
  const settled = await done
  const rendered = await finishReview({ jobId, env, scope: prep.scope, base: prep.base, truncated: prep.truncated })
  if (settled.state === 'failed') {
    return { stdout: `${rendered}\n\nThe job ended in state "failed": ${settled.error ?? 'unknown error'}.`, exitCode: 1 }
  }
  return { stdout: rendered, exitCode: 0 }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/integration/review-verb.test.mjs`
Expected: PASS, 9 tests

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/review-job.mjs scripts/opencode-companion.mjs agents/opencode-review.md tests/integration/review-verb.test.mjs
git commit -m "feat: review and adversarial-review verbs with a read-only review agent"
```

---

## Task 15: `task`, `task-resume-candidate`, and the rescue subagent

**Files:**
- Modify: `scripts/opencode-companion.mjs`
- Create: `agents/opencode-rescue.md`
- Test: `tests/integration/task-verb.test.mjs`

**Interfaces:**
- Consumes: `startJob` (`lib/job-control.mjs`); `lastOpencodeSession`, `readResult`, `readJob` (`lib/tracked-jobs.mjs`); `runDoctor`, `requireReady`.
- Produces (companion verbs):
  - `task [--background|--wait] [--resume|--fresh] [--session <id>] [--model m] [--variant v] -- <task text>` — default foreground. Rescue runs with write access: no `tools` override, `--auto` semantics come from the server-side agent. Prints the model's raw output for a foreground run; a background run prints the same "Started …" line as `review`.
  - `task-resume-candidate --json` — prints `{"hasCandidate": boolean, "sessionID": string|null, "lastVerb": string|null, "lastEndedAt": number|null}` for this Claude Code session, exit 0 either way.
- Produces (`agents/opencode-rescue.md`): a Claude Code subagent that makes exactly one `Bash` call and returns stdout unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/task-verb.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'

const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))

async function sandbox(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'octask-'))
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: fixture,
    CLAUDE_SESSION_ID: 'cc-task',
    ...extra,
  }
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  await writeFile(join(env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  await writeFile(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"openrouter/x"}')
  return { env, home }
}

const cli = (env, cwd, args) => run(process.execPath, [companion, ...args], { env, cwd, timeoutMs: 60000 })

test('task-resume-candidate reports no candidate on a fresh session', async () => {
  const s = await sandbox()
  const r = await cli(s.env, s.home, ['task-resume-candidate', '--json'])
  assert.equal(r.code, 0)
  const c = JSON.parse(r.stdout)
  assert.equal(c.hasCandidate, false)
  assert.equal(c.sessionID, null)
})

test('a foreground task prints the model output verbatim', async () => {
  const s = await sandbox()
  const r = await cli(s.env, s.home, ['task', '--wait', '--', 'fix the parser'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /"findings"/)
})

test('task-resume-candidate reports the prior session afterwards', async () => {
  const s = await sandbox()
  await cli(s.env, s.home, ['task', '--wait', '--', 'first task'])
  const c = JSON.parse((await cli(s.env, s.home, ['task-resume-candidate', '--json'])).stdout)
  assert.equal(c.hasCandidate, true)
  assert.match(c.sessionID, /^ses_/)
  assert.equal(c.lastVerb, 'task')
})

test('task --resume continues the remembered session', async () => {
  const s = await sandbox()
  await cli(s.env, s.home, ['task', '--wait', '--', 'first'])
  const before = JSON.parse((await cli(s.env, s.home, ['task-resume-candidate', '--json'])).stdout)
  const r = await cli(s.env, s.home, ['task', '--wait', '--resume', '--', 'keep going'])
  assert.equal(r.code, 0)
  const after = JSON.parse((await cli(s.env, s.home, ['task-resume-candidate', '--json'])).stdout)
  assert.equal(after.sessionID, before.sessionID)
})

test('task --fresh starts a new session', async () => {
  const s = await sandbox()
  await cli(s.env, s.home, ['task', '--wait', '--', 'first'])
  const before = JSON.parse((await cli(s.env, s.home, ['task-resume-candidate', '--json'])).stdout)
  await cli(s.env, s.home, ['task', '--wait', '--fresh', '--', 'unrelated'])
  const after = JSON.parse((await cli(s.env, s.home, ['task-resume-candidate', '--json'])).stdout)
  assert.notEqual(after.sessionID, before.sessionID)
})

test('task --background returns a job id immediately', async () => {
  const s = await sandbox({ FAKE_OPENCODE_EVENT_DELAY_MS: '150' })
  const r = await cli(s.env, s.home, ['task', '--background', '--', 'long job'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /job_[a-z0-9]+/)
})

test('task with no text exits non-zero', async () => {
  const s = await sandbox()
  const r = await cli(s.env, s.home, ['task', '--wait'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /task text/i)
})

test('a failing job surfaces the error and a non-zero exit', async () => {
  const s = await sandbox()
  const script = join(s.home, 'script.jsonl')
  await writeFile(script, JSON.stringify({ type: 'session.error', properties: { error: { name: 'ProviderAuthError' } } }) + '\n')
  const r = await cli({ ...s.env, FAKE_OPENCODE_SCRIPT: script }, s.home, ['task', '--wait', '--', 'boom'])
  assert.equal(r.code, 1)
  assert.match(r.stderr + r.stdout, /ProviderAuthError/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/integration/task-verb.test.mjs`
Expected: FAIL — `unknown verb: task-resume-candidate`

- [ ] **Step 3: Add the verbs to `scripts/opencode-companion.mjs`**

Imports:

```js
import { lastOpencodeSession, listJobs, readResult } from './lib/tracked-jobs.mjs'
```

Handlers:

```js
  'task-resume-candidate': async ({ env, ccSessionId }) => {
    const sessionID = await lastOpencodeSession(ccSessionId, env)
    const jobs = await listJobs(ccSessionId, env)
    const last = jobs.find(j => j.sessionID === sessionID) ?? null
    const payload = {
      hasCandidate: Boolean(sessionID),
      sessionID: sessionID ?? null,
      lastVerb: last?.verb ?? null,
      lastEndedAt: last?.endedAt ?? null,
    }
    return { stdout: JSON.stringify(payload, null, 2), exitCode: 0 }
  },

  task: async ({ flags, positional, env, cwd, ccSessionId }) => {
    const report = await runDoctor({ env, cwd, checkServer: false })
    requireReady(report)

    const text = positional.join(' ').trim()
    if (!text) throw new CompanionError('task requires task text, e.g. opencode-companion.mjs task -- fix the flaky test')

    let resumeSessionID
    if (flags.session && flags.session !== true) resumeSessionID = String(flags.session)
    else if (flags.resume && !flags.fresh) {
      resumeSessionID = await lastOpencodeSession(ccSessionId, env) ?? undefined
      if (!resumeSessionID) throw new CompanionError('there is no prior opencode session in this Claude Code session to resume')
    }

    const jobOpts = {
      ccSessionId,
      verb: 'task',
      prompt: text,
      cwd,
      resumeSessionID,
      model: flags.model && flags.model !== true ? String(flags.model) : undefined,
      variant: (flags.variant ?? flags.effort) && flags.variant !== true ? String(flags.variant ?? flags.effort) : undefined,
      env,
    }

    if (flags.background) {
      const { jobId } = await startJob(jobOpts)
      return {
        stdout: `Started task as ${jobId}. Check it with /opencode:status, read it with /opencode:result ${jobId}.`,
        exitCode: 0,
      }
    }

    const { jobId, done } = await startJob(jobOpts)
    const settled = await done
    const output = (await readResult(jobId, env)) ?? ''
    if (settled.state !== 'done') {
      throw new CompanionError(
        `${output}\n\nThe opencode task ended in state "${settled.state}"${settled.error ? `: ${settled.error}` : ''} (${jobId}).`
      )
    }
    return { stdout: output || `The task finished with no output (${jobId}).`, exitCode: 0 }
  },
```

- [ ] **Step 4: Write `agents/opencode-rescue.md`**

```markdown
---
name: opencode-rescue
description: Forwards a coding task to the opencode CLI and returns its output unchanged. Use when the user runs /opencode:rescue.
tools: Bash
---

You are a forwarder. You make exactly one tool call and then stop.

1. Run the `Bash` command you were given, which invokes
   `opencode-companion.mjs task ...`.
2. Return its stdout as your entire final message, byte for byte.

You do not inspect files, read the repository, poll job status, fetch results,
summarize, reformat, add commentary, or do follow-up work. If the command exits
non-zero, return its stderr unchanged instead. That is the whole job.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/integration/task-verb.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 6: Commit**

```bash
git add scripts/opencode-companion.mjs agents/opencode-rescue.md tests/integration/task-verb.test.mjs
git commit -m "feat: task and task-resume-candidate verbs plus the rescue forwarder subagent"
```

---

## Task 16: `transfer` — one-way conversation export

**Files:**
- Modify: `scripts/opencode-companion.mjs`
- Create: `scripts/lib/claude-session-transfer.mjs`
- Test: `tests/unit/claude-session-transfer.test.mjs`, `tests/integration/transfer-verb.test.mjs`

**Interfaces:**
- Consumes: `ensureBroker` (`lib/broker-lifecycle.mjs`); `rememberOpencodeSession` (`lib/tracked-jobs.mjs`); `stateRoot`, `ensureDir` (`lib/state.mjs`); `atomicWrite` (`lib/fs.mjs`); `resolveBinary` (`lib/opencode.mjs`).
- Produces (`claude-session-transfer.mjs`):
  - `transcriptPath({env?, ccSessionId, cwd}): Promise<string|null>` — resolves `$CLAUDE_TRANSCRIPT_PATH` first; otherwise looks for `~/.claude/projects/<slug>/<ccSessionId>.jsonl` where `<slug>` is `cwd` with `/` and `.` replaced by `-`; returns `null` when nothing is found
  - `readTranscript(path): Promise<Array<{role: string, text: string}>>` — parses the Claude Code JSONL transcript, keeping entries whose `type` is `user` or `assistant`, flattening `message.content` string-or-array into text and dropping tool-call parts. Tolerates unknown shapes by skipping the line.
  - `buildHandoff({messages, cwd, ccSessionId, maxChars = 120_000}): string` — a markdown document: a title, the repo path, a "this is an exported Claude Code conversation, continue the work" preamble, then `## user` / `## assistant` sections oldest-first, truncated from the **front** (oldest dropped first) with a `[earlier turns omitted]` marker when over `maxChars`
  - `writeHandoff({text, ccSessionId, env?}): Promise<string>` — writes `<stateRoot>/transfers/<ccSessionId>-<timestamp>.md` and returns the path
- Produces (companion verb):
  - `transfer [--out <path>]` — builds the handoff, creates an opencode session titled `Transferred from Claude Code`, seeds it with `prompt_async` (the handoff text as a single text part), remembers the session id, and prints the handoff path, the session id, and the exact resume command `opencode --session <id>`. When the transcript cannot be found, it still writes the handoff from whatever is available and says so; it never fails silently.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/claude-session-transfer.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transcriptPath, readTranscript, buildHandoff, writeHandoff } from '../../scripts/lib/claude-session-transfer.mjs'

test('transcriptPath prefers CLAUDE_TRANSCRIPT_PATH when it exists', async () => {
  const d = await mkdtemp(join(tmpdir(), 'octr-'))
  const f = join(d, 't.jsonl')
  await writeFile(f, '')
  assert.equal(await transcriptPath({ env: { CLAUDE_TRANSCRIPT_PATH: f }, ccSessionId: 'x', cwd: d }), f)
})

test('transcriptPath finds the projects-dir transcript', async () => {
  const home = await mkdtemp(join(tmpdir(), 'octr-'))
  const cwd = '/Volumes/R/proj'
  const slug = cwd.replaceAll('/', '-').replaceAll('.', '-')
  const dir = join(home, '.claude', 'projects', slug)
  await mkdir(dir, { recursive: true })
  const f = join(dir, 'sess-1.jsonl')
  await writeFile(f, '')
  assert.equal(await transcriptPath({ env: { HOME: home }, ccSessionId: 'sess-1', cwd }), f)
})

test('transcriptPath returns null when nothing is found', async () => {
  const home = await mkdtemp(join(tmpdir(), 'octr-'))
  assert.equal(await transcriptPath({ env: { HOME: home }, ccSessionId: 'nope', cwd: '/x' }), null)
})

test('readTranscript keeps user and assistant text and skips tool parts', async () => {
  const d = await mkdtemp(join(tmpdir(), 'octr-'))
  const f = join(d, 't.jsonl')
  await writeFile(f, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the bug' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', name: 'Read', input: {} }] } }),
    'not json at all',
    JSON.stringify({ type: 'system', message: { content: 'ignore me' } }),
  ].join('\n'))
  assert.deepEqual(await readTranscript(f), [
    { role: 'user', text: 'fix the bug' },
    { role: 'assistant', text: 'looking' },
  ])
})

test('buildHandoff renders oldest-first sections with a preamble', () => {
  const out = buildHandoff({
    messages: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'second' }],
    cwd: '/repo', ccSessionId: 'cc-1',
  })
  assert.match(out, /\/repo/)
  assert.ok(out.indexOf('first') < out.indexOf('second'))
  assert.match(out, /## user/)
  assert.match(out, /## assistant/)
})

test('buildHandoff truncates the oldest turns first and says so', () => {
  const messages = Array.from({ length: 50 }, (_, i) => ({ role: 'user', text: `turn-${i} ` + 'x'.repeat(500) }))
  const out = buildHandoff({ messages, cwd: '/repo', ccSessionId: 'cc-1', maxChars: 3000 })
  assert.match(out, /earlier turns omitted/)
  assert.match(out, /turn-49/)
  assert.equal(out.includes('turn-0 '), false)
  assert.ok(out.length <= 4000)
})

test('buildHandoff handles an empty transcript without crashing', () => {
  const out = buildHandoff({ messages: [], cwd: '/repo', ccSessionId: 'cc-1' })
  assert.match(out, /no conversation content/i)
})

test('writeHandoff writes under the state dir and returns the path', async () => {
  const env = { XDG_STATE_HOME: await mkdtemp(join(tmpdir(), 'octr-')), HOME: '/nonexistent' }
  const p = await writeHandoff({ text: '# hi', ccSessionId: 'cc-1', env })
  assert.match(p, /transfers\/cc-1-\d+\.md$/)
})
```

- [ ] **Step 2: Write the failing integration test**

Create `tests/integration/transfer-verb.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'

const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'octrans-'))
  const transcript = join(home, 't.jsonl')
  await writeFile(transcript, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'port the parser to the new API' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I started on lib/parse.js' }] } }),
  ].join('\n'))
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: fixture,
    CLAUDE_SESSION_ID: 'cc-transfer',
    CLAUDE_TRANSCRIPT_PATH: transcript,
  }
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  await writeFile(join(env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  await writeFile(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"openrouter/x"}')
  return { env, home }
}

test('transfer writes a handoff, creates a session, and prints the resume command', async () => {
  const s = await sandbox()
  const r = await run(process.execPath, [companion, 'transfer'], { env: s.env, cwd: s.home, timeoutMs: 60000 })
  assert.equal(r.code, 0)
  const sessionMatch = r.stdout.match(/opencode --session (ses_\S+)/)
  assert.ok(sessionMatch, r.stdout)
  const pathMatch = r.stdout.match(/(\S+\.md)/)
  assert.ok(pathMatch)
  const handoff = await readFile(pathMatch[1], 'utf8')
  assert.match(handoff, /port the parser/)
  assert.match(handoff, /lib\/parse\.js/)
})

test('transfer --out writes to the requested path', async () => {
  const s = await sandbox()
  const out = join(s.home, 'handoff.md')
  const r = await run(process.execPath, [companion, 'transfer', '--out', out], { env: s.env, cwd: s.home, timeoutMs: 60000 })
  assert.equal(r.code, 0)
  assert.match(await readFile(out, 'utf8'), /port the parser/)
})

test('transfer without a findable transcript still produces a handoff and says so', async () => {
  const s = await sandbox()
  const env = { ...s.env, CLAUDE_TRANSCRIPT_PATH: join(s.home, 'missing.jsonl') }
  const r = await run(process.execPath, [companion, 'transfer'], { env, cwd: s.home, timeoutMs: 60000 })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /could not be located/i)
  assert.match(r.stdout, /ses_/)
})
```

- [ ] **Step 3: Run both to verify they fail**

Run: `node --test tests/unit/claude-session-transfer.test.mjs tests/integration/transfer-verb.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/lib/claude-session-transfer.mjs'`

- [ ] **Step 4: Write `scripts/lib/claude-session-transfer.mjs`**

```js
import { join } from 'node:path'
import { readFile, access } from 'node:fs/promises'
import { stateRoot, ensureDir } from './state.mjs'
import { atomicWrite } from './fs.mjs'

const exists = async (p) => { try { await access(p); return true } catch { return false } }

export async function transcriptPath({ env = process.env, ccSessionId, cwd }) {
  const explicit = env.CLAUDE_TRANSCRIPT_PATH
  if (explicit && await exists(explicit)) return explicit
  const home = env.HOME
  if (!home) return null
  const slug = String(cwd).replaceAll('/', '-').replaceAll('.', '-')
  const candidate = join(home, '.claude', 'projects', slug, `${ccSessionId}.jsonl`)
  return (await exists(candidate)) ? candidate : null
}

function flattenContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim()
}

export async function readTranscript(path) {
  let text
  try { text = await readFile(path, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const role = entry?.message?.role ?? entry?.type
    if (role !== 'user' && role !== 'assistant') continue
    const body = flattenContent(entry?.message?.content)
    if (!body) continue
    out.push({ role, text: body })
  }
  return out
}

export function buildHandoff({ messages, cwd, ccSessionId, maxChars = 120_000 }) {
  const header = [
    '# Handoff from Claude Code',
    '',
    `Repository: ${cwd}`,
    `Claude Code session: ${ccSessionId}`,
    '',
    'This is a one-way export of a Claude Code conversation. Read it, then continue',
    'the work it describes in this opencode session. The Claude Code side is not',
    'listening — nothing you write here goes back to it.',
    '',
    '---',
    '',
  ].join('\n')

  if (!messages.length) {
    return header + '(The transcript contained no conversation content.)\n'
  }

  const sections = messages.map(m => `## ${m.role}\n\n${m.text}\n`)
  const budget = maxChars - header.length
  const kept = []
  let used = 0
  for (let i = sections.length - 1; i >= 0; i--) {
    if (used + sections[i].length > budget) break
    kept.unshift(sections[i])
    used += sections[i].length
  }
  const omitted = sections.length - kept.length
  const marker = omitted > 0 ? `_[${omitted} earlier turns omitted to fit the handoff]_\n\n` : ''
  return header + marker + kept.join('\n')
}

export async function writeHandoff({ text, ccSessionId, env = process.env }) {
  const dir = join(stateRoot(env), 'transfers')
  await ensureDir(dir)
  const path = join(dir, `${ccSessionId}-${Date.now()}.md`)
  await atomicWrite(path, text)
  return path
}
```

- [ ] **Step 5: Add the `transfer` verb to `scripts/opencode-companion.mjs`**

Imports:

```js
import { transcriptPath, readTranscript, buildHandoff, writeHandoff } from './lib/claude-session-transfer.mjs'
import { ensureBroker } from './lib/broker-lifecycle.mjs'
import { rememberOpencodeSession } from './lib/tracked-jobs.mjs'
import { atomicWrite } from './lib/fs.mjs'
```

Handler:

```js
  transfer: async ({ flags, env, cwd, ccSessionId }) => {
    const report = await runDoctor({ env, cwd, checkServer: false })
    requireReady(report)

    const tPath = await transcriptPath({ env, ccSessionId, cwd })
    const messages = tPath ? await readTranscript(tPath) : []
    const handoff = buildHandoff({ messages, cwd, ccSessionId })

    const outPath = flags.out && flags.out !== true
      ? String(flags.out)
      : await writeHandoff({ text: handoff, ccSessionId, env })
    if (flags.out && flags.out !== true) await atomicWrite(outPath, handoff)

    const broker = await ensureBroker({ env })
    const session = await broker.client.createSession({ title: 'Transferred from Claude Code' })
    await broker.client.promptAsync(session.id, { parts: [{ type: 'text', text: handoff }] })
    await rememberOpencodeSession(ccSessionId, session.id, env)

    const lines = []
    if (!tPath) lines.push('The Claude Code transcript could not be located; the handoff contains only session metadata.')
    lines.push(`Handoff written to ${outPath}`)
    lines.push(`Seeded opencode session: ${session.id}`)
    lines.push('')
    lines.push('Resume it natively with:')
    lines.push(`  opencode --session ${session.id}`)
    lines.push('')
    lines.push('This is a one-way export. Work done in opencode does not flow back to this Claude Code session.')
    return { stdout: lines.join('\n'), exitCode: 0 }
  },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/unit/claude-session-transfer.test.mjs tests/integration/transfer-verb.test.mjs`
Expected: PASS, 11 tests

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/claude-session-transfer.mjs scripts/opencode-companion.mjs tests/unit/claude-session-transfer.test.mjs tests/integration/transfer-verb.test.mjs
git commit -m "feat: one-way conversation transfer into a seeded opencode session"
```

---

## Task 17: `status`, `result`, and `cancel`

**Files:**
- Modify: `scripts/opencode-companion.mjs`, `tests/integration/companion-dispatch.test.mjs`
- Test: `tests/integration/job-verbs.test.mjs`

**Interfaces:**
- Consumes: `listJobs`, `readJob`, `readResult` (`lib/tracked-jobs.mjs`); `cancelJob`, `cancelAll` (`lib/job-control.mjs`); `renderJobList`, `renderJobResult` (`lib/render.mjs`).
- Produces (companion verbs):
  - `status` — `renderJobList(await listJobs(ccSessionId))`, exit 0 even when empty
  - `result <jobId>` — for a finished review/adversarial-review job, renders through `finishReview` so findings are formatted; for any other verb or an unfinished job, `renderJobResult`. Exit 1 with a clear message for an unknown job id, or a job belonging to another Claude Code session (message: `job <id> belongs to a different Claude Code session`).
  - `cancel <jobId>` / `cancel --all` — prints what was cancelled; exit 0 when nothing was running, exit 1 for an unknown id.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/job-verbs.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'

const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))

async function sandbox(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ocjv-'))
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: fixture,
    CLAUDE_SESSION_ID: 'cc-a',
    ...extra,
  }
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  await writeFile(join(env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  await writeFile(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"openrouter/x"}')
  return { env, home }
}

const cli = (env, cwd, args) => run(process.execPath, [companion, ...args], { env, cwd, timeoutMs: 60000 })

test('status reports no jobs on a fresh session', async () => {
  const s = await sandbox()
  const r = await cli(s.env, s.home, ['status'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /No opencode jobs/)
})

test('status lists a finished job with its verb and state', async () => {
  const s = await sandbox()
  await cli(s.env, s.home, ['task', '--wait', '--', 'do a thing'])
  const r = await cli(s.env, s.home, ['status'])
  assert.match(r.stdout, /task/)
  assert.match(r.stdout, /done/)
  assert.match(r.stdout, /job_/)
})

test('jobs are not visible from another Claude Code session', async () => {
  const s = await sandbox()
  await cli(s.env, s.home, ['task', '--wait', '--', 'mine'])
  const other = await cli({ ...s.env, CLAUDE_SESSION_ID: 'cc-b' }, s.home, ['status'])
  assert.match(other.stdout, /No opencode jobs/)
})

test('result prints a finished job output', async () => {
  const s = await sandbox()
  const started = await cli(s.env, s.home, ['task', '--wait', '--', 'x'])
  assert.equal(started.code, 0)
  const list = await cli(s.env, s.home, ['status'])
  const jobId = list.stdout.match(/(job_[a-z0-9]+)/)[1]
  const r = await cli(s.env, s.home, ['result', jobId])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /findings/)
})

test('result on an unknown job exits 1', async () => {
  const s = await sandbox()
  const r = await cli(s.env, s.home, ['result', 'job_nope'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /job_nope/)
})

test('result refuses a job from another Claude Code session', async () => {
  const s = await sandbox()
  await cli(s.env, s.home, ['task', '--wait', '--', 'mine'])
  const jobId = (await cli(s.env, s.home, ['status'])).stdout.match(/(job_[a-z0-9]+)/)[1]
  const r = await cli({ ...s.env, CLAUDE_SESSION_ID: 'cc-b' }, s.home, ['result', jobId])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /different Claude Code session/)
})

test('cancel --all reports when nothing is running', async () => {
  const s = await sandbox()
  const r = await cli(s.env, s.home, ['cancel', '--all'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /nothing/i)
})

test('cancel stops a running background job', async () => {
  const s = await sandbox({ FAKE_OPENCODE_EVENT_DELAY_MS: '400' })
  const started = await cli(s.env, s.home, ['task', '--background', '--', 'long'])
  const jobId = started.stdout.match(/(job_[a-z0-9]+)/)[1]
  const r = await cli(s.env, s.home, ['cancel', jobId])
  assert.equal(r.code, 0)
  assert.match(r.stdout, new RegExp(jobId))
  const status = await cli(s.env, s.home, ['status'])
  assert.match(status.stdout, /cancelled|stale/)
})

test('cancel on an unknown job exits 1', async () => {
  const s = await sandbox()
  const r = await cli(s.env, s.home, ['cancel', 'job_nope'])
  assert.equal(r.code, 1)
})

test('result on a still-running job shows the partial tail with a banner', async () => {
  const s = await sandbox({ FAKE_OPENCODE_EVENT_DELAY_MS: '400' })
  const started = await cli(s.env, s.home, ['task', '--background', '--', 'long'])
  const jobId = started.stdout.match(/(job_[a-z0-9]+)/)[1]
  const r = await cli(s.env, s.home, ['result', jobId])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /still running/i)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/integration/job-verbs.test.mjs`
Expected: FAIL — `unknown verb: status`

- [ ] **Step 3: Add the three verbs to `scripts/opencode-companion.mjs`**

Imports:

```js
import { readJob } from './lib/tracked-jobs.mjs'
import { cancelJob, cancelAll } from './lib/job-control.mjs'
import { renderJobList, renderJobResult } from './lib/render.mjs'
```

Handlers:

```js
  status: async ({ env, ccSessionId }) => {
    const jobs = await listJobs(ccSessionId, env)
    return { stdout: renderJobList(jobs), exitCode: 0 }
  },

  result: async ({ positional, env, ccSessionId }) => {
    const jobId = positional[0]
    if (!jobId) throw new CompanionError('result requires a job id, e.g. result job_abc123')
    const job = await readJob(jobId, env)
    if (!job) throw new CompanionError(`unknown job: ${jobId}. Run /opencode:status to see this session's jobs.`)
    if (job.ccSessionId !== ccSessionId) {
      throw new CompanionError(`job ${jobId} belongs to a different Claude Code session.`)
    }
    const text = await readResult(jobId, env)
    const isReview = job.verb === 'review' || job.verb === 'adversarial-review'
    if (isReview && job.state !== 'running') {
      const rendered = await finishReview({
        jobId, env,
        scope: job.meta?.scope ?? 'working-tree',
        base: job.meta?.base ?? null,
        truncated: job.meta?.truncated ?? false,
      })
      return { stdout: rendered, exitCode: 0 }
    }
    return { stdout: renderJobResult(job, text), exitCode: 0 }
  },

  cancel: async ({ flags, positional, env, ccSessionId }) => {
    if (flags.all) {
      const ids = await cancelAll(ccSessionId, env)
      return {
        stdout: ids.length ? `Cancelled ${ids.length} job(s): ${ids.join(', ')}` : 'There was nothing running to cancel.',
        exitCode: 0,
      }
    }
    const jobId = positional[0]
    if (!jobId) throw new CompanionError('cancel requires a job id or --all')
    const job = await readJob(jobId, env)
    if (!job) throw new CompanionError(`unknown job: ${jobId}`)
    if (job.ccSessionId !== ccSessionId) throw new CompanionError(`job ${jobId} belongs to a different Claude Code session.`)
    const outcome = await cancelJob(jobId, env)
    const message = outcome === 'cancelled'
      ? `Cancelled ${jobId}.`
      : `${jobId} had already finished (state: ${job.state}); nothing to cancel.`
    return { stdout: message, exitCode: 0 }
  },
```

- [ ] **Step 4: Record review scope on the job so `result` can re-render it**

In `reviewVerb` (Task 14), pass the scope through to the job record. Change the
`jobOpts` object to include:

```js
    meta: { scope: prep.scope, base: prep.base, truncated: prep.truncated },
```

and in `lib/job-control.mjs`'s `startJob`, merge the caller's `meta` into the job
record — change the `createJob` call to:

```js
  const job = await createJob({ ccSessionId, verb, cwd, meta: { agent, model, variant, ...(opts.meta ?? {}) } }, env)
```

where `startJob`'s signature gains `meta` and the destructure becomes:

```js
export async function startJob(opts) {
  const {
    ccSessionId, verb, prompt, system, agent, model, variant, cwd,
    tools, resumeSessionID, env = process.env,
  } = opts
```

- [ ] **Step 5: Restore the full verb list in the dispatch test**

In `tests/integration/companion-dispatch.test.mjs`, change the `--help` assertion list back to:

```js
  for (const v of ['doctor', 'review', 'adversarial-review', 'review-size', 'task', 'task-resume-candidate', 'transfer', 'status', 'result', 'cancel', 'set-key', 'set-model', 'models', 'gate', 'repair']) {
    assert.match(r.stdout, new RegExp(`\\b${v.replace('-', '\\-')}\\b`), v)
  }
```

- [ ] **Step 6: Run the whole suite to verify it passes**

Run: `npm test`
Expected: PASS — every unit and integration test, including the restored dispatch test

- [ ] **Step 7: Commit**

```bash
git add scripts/opencode-companion.mjs scripts/lib/job-control.mjs tests/integration/job-verbs.test.mjs tests/integration/companion-dispatch.test.mjs
git commit -m "feat: status, result, and cancel job-control verbs"
```

---

## Task 18: Hooks — session lifecycle and the Stop review gate

**Files:**
- Create: `hooks/hooks.json`, `scripts/session-lifecycle-hook.mjs`, `scripts/stop-review-gate-hook.mjs`
- Test: `tests/integration/hooks.test.mjs`

**Interfaces:**
- Consumes: `registerSession`, `unregisterSession`, `pruneStale` (`lib/tracked-jobs.mjs`); `addRef`, `releaseRef`, `reapOrphans` (`lib/broker-lifecycle.mjs`); `cancelAll` (`lib/job-control.mjs`); `readGate` (`lib/gate.mjs`); `prepareReview`, `REVIEW_AGENT`, `REVIEW_TOOLS` (`lib/review-job.mjs`); `runForeground` (`lib/job-control.mjs`); `parseReviewOutput` (`lib/review-schema.mjs`); `runDoctor` (`lib/doctor.mjs`).
- Produces:
  - Both hooks read the Claude Code hook JSON payload from **stdin** and take `session_id` and `cwd` from it, falling back to `CLAUDE_SESSION_ID` and `process.cwd()`.
  - `session-lifecycle-hook.mjs <SessionStart|SessionEnd>`:
    - `SessionStart` — `registerSession`, `pruneStale`, `reapOrphans`, `addRef`. Exits 0 and prints nothing on success. Never blocks a session: any error is written to stderr and the exit code is still 0.
    - `SessionEnd` — `cancelAll` for this session, `unregisterSession`, `releaseRef` (shutting the broker down when it was the last). Same never-block rule.
  - `stop-review-gate-hook.mjs`:
    - Exits 0 immediately (no output) when the gate is off, when doctor is not ready, when the working tree is empty, or when anything throws — the gate must never wedge a session.
    - When on and there is work: runs a foreground review with `prompts/stop-review-gate.md`, and if there are findings of severity `critical` or `high`, prints a JSON decision object on stdout: `{"decision": "block", "reason": "<rendered blocking findings>"}` and exits 0. Otherwise exits 0 silently.
  - `hooks/hooks.json` wires all three events to these scripts with `${CLAUDE_PLUGIN_ROOT}` paths and a 120s timeout on the Stop gate.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/hooks.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'

const lifecycle = fileURLToPath(new URL('../../scripts/session-lifecycle-hook.mjs', import.meta.url))
const gate = fileURLToPath(new URL('../../scripts/stop-review-gate-hook.mjs', import.meta.url))
const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))

async function sandbox(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ochook-'))
  const repo = join(home, 'repo')
  await mkdir(repo, { recursive: true })
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: fixture,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
    ...extra,
  }
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  await writeFile(join(env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  await writeFile(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"openrouter/x"}')
  const git = (...a) => run('git', a, { cwd: repo, env })
  await git('init', '-b', 'main')
  await writeFile(join(repo, 'a.js'), 'let x = 1\n')
  await git('add', '.')
  await git('commit', '-m', 'init')
  return { env, home, repo }
}

const hook = (script, args, env, payload) =>
  run(process.execPath, [script, ...args], { env, input: JSON.stringify(payload), timeoutMs: 60000 })

test('SessionStart registers the session and exits 0 silently', async () => {
  const s = await sandbox()
  const r = await hook(lifecycle, ['SessionStart'], s.env, { session_id: 'cc-1', cwd: s.repo })
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), '')
  const sessions = join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'sessions')
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(sessions), ['cc-1.json'])
})

test('SessionStart never blocks even when the binary is missing', async () => {
  const s = await sandbox({ OPENCODE_BIN: '/nonexistent/opencode' })
  const r = await hook(lifecycle, ['SessionStart'], s.env, { session_id: 'cc-1', cwd: s.repo })
  assert.equal(r.code, 0)
})

test('SessionEnd unregisters the session', async () => {
  const s = await sandbox()
  await hook(lifecycle, ['SessionStart'], s.env, { session_id: 'cc-1', cwd: s.repo })
  const r = await hook(lifecycle, ['SessionEnd'], s.env, { session_id: 'cc-1', cwd: s.repo })
  assert.equal(r.code, 0)
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'sessions')), [])
})

test('SessionEnd cancels this session running jobs', async () => {
  const s = await sandbox({ FAKE_OPENCODE_EVENT_DELAY_MS: '400' })
  const started = await run(process.execPath, [companion, 'task', '--background', '--', 'long'],
    { env: { ...s.env, CLAUDE_SESSION_ID: 'cc-1' }, cwd: s.repo, timeoutMs: 60000 })
  const jobId = started.stdout.match(/(job_[a-z0-9]+)/)[1]
  await hook(lifecycle, ['SessionEnd'], s.env, { session_id: 'cc-1', cwd: s.repo })
  const meta = JSON.parse(await readFile(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'jobs', jobId, 'meta.json'), 'utf8'))
  assert.ok(['cancelled', 'stale'].includes(meta.state), meta.state)
})

test('the Stop gate is silent when it is off', async () => {
  const s = await sandbox()
  await writeFile(join(s.repo, 'a.js'), 'let x = 2\n')
  const r = await hook(gate, [], { ...s.env, CLAUDE_SESSION_ID: 'cc-1' }, { session_id: 'cc-1', cwd: s.repo })
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), '')
})

test('the Stop gate blocks on a high-severity finding when it is on', async () => {
  const s = await sandbox()
  await run(process.execPath, [companion, 'gate', '--on'], { env: s.env })
  await writeFile(join(s.repo, 'a.js'), 'let x = 2\n')
  const r = await hook(gate, [], { ...s.env, CLAUDE_SESSION_ID: 'cc-1' }, { session_id: 'cc-1', cwd: s.repo })
  assert.equal(r.code, 0)
  const decision = JSON.parse(r.stdout)
  assert.equal(decision.decision, 'block')
  assert.match(decision.reason, /Null deref/)
})

test('the Stop gate is silent on a clean tree even when on', async () => {
  const s = await sandbox()
  await run(process.execPath, [companion, 'gate', '--on'], { env: s.env })
  const r = await hook(gate, [], { ...s.env, CLAUDE_SESSION_ID: 'cc-1' }, { session_id: 'cc-1', cwd: s.repo })
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), '')
})

test('the Stop gate is silent when only low-severity findings come back', async () => {
  const s = await sandbox()
  const script = join(s.home, 'low.jsonl')
  await writeFile(script, [
    JSON.stringify({ type: 'session.next.text.delta', properties: { delta: '{"findings":[{"file":"a.js","line":1,"severity":"low","confidence":"low","body":"nit"}]}' } }),
    JSON.stringify({ type: 'session.idle', properties: {} }),
  ].join('\n') + '\n')
  await run(process.execPath, [companion, 'gate', '--on'], { env: s.env })
  await writeFile(join(s.repo, 'a.js'), 'let x = 3\n')
  const r = await hook(gate, [], { ...s.env, CLAUDE_SESSION_ID: 'cc-1', FAKE_OPENCODE_SCRIPT: script }, { session_id: 'cc-1', cwd: s.repo })
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), '')
})

test('the Stop gate exits 0 silently when opencode is not ready', async () => {
  const s = await sandbox()
  await run(process.execPath, [companion, 'gate', '--on'], { env: s.env })
  await writeFile(join(s.repo, 'a.js'), 'let x = 4\n')
  const r = await hook(gate, [], { ...s.env, OPENCODE_BIN: '/nonexistent/opencode', CLAUDE_SESSION_ID: 'cc-1' }, { session_id: 'cc-1', cwd: s.repo })
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), '')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/integration/hooks.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/session-lifecycle-hook.mjs'`

- [ ] **Step 3: Write `scripts/session-lifecycle-hook.mjs`**

```js
#!/usr/bin/env node
import { registerSession, unregisterSession, pruneStale } from './lib/tracked-jobs.mjs'
import { addRef, releaseRef, reapOrphans } from './lib/broker-lifecycle.mjs'
import { cancelAll } from './lib/job-control.mjs'

async function readPayload() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return {} }
}

const event = process.argv[2]
const payload = await readPayload()
const ccSessionId = payload.session_id || process.env.CLAUDE_SESSION_ID || 'default'

try {
  if (event === 'SessionStart') {
    await registerSession(ccSessionId)
    await pruneStale()
    await reapOrphans()
    await addRef(ccSessionId)
  } else if (event === 'SessionEnd') {
    await cancelAll(ccSessionId).catch(() => {})
    await unregisterSession(ccSessionId)
    await releaseRef(ccSessionId)
  } else {
    process.stderr.write(`opencode-plugin-cc: unknown lifecycle event: ${event}\n`)
  }
} catch (err) {
  // A lifecycle hook must never block a Claude Code session.
  process.stderr.write(`opencode-plugin-cc ${event} hook: ${err.message}\n`)
}
process.exit(0)
```

- [ ] **Step 4: Write `scripts/stop-review-gate-hook.mjs`**

```js
#!/usr/bin/env node
import { readGate } from './lib/gate.mjs'
import { runDoctor } from './lib/doctor.mjs'
import { resolveScope, sizeChange, collectDiff, repoRoot } from './lib/git.mjs'
import { loadPrompt } from './lib/prompts.mjs'
import { startJob } from './lib/job-control.mjs'
import { readResult } from './lib/tracked-jobs.mjs'
import { parseReviewOutput } from './lib/review-schema.mjs'
import { REVIEW_AGENT, REVIEW_TOOLS } from './lib/review-job.mjs'

const BLOCKING = new Set(['critical', 'high'])

async function readPayload() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return {} }
}

async function gate() {
  if (!(await readGate())) return null

  const payload = await readPayload()
  const ccSessionId = payload.session_id || process.env.CLAUDE_SESSION_ID || 'default'
  const cwd = payload.cwd || process.cwd()

  const report = await runDoctor({ cwd, checkServer: false })
  if (!report.ok) return null

  const root = await repoRoot(cwd)
  const resolved = await resolveScope({ cwd: root, scope: 'working-tree' })
  const size = await sizeChange({ cwd: root, scope: resolved.scope, base: resolved.base })
  if (size.empty) return null

  const diff = await collectDiff({ cwd: root, scope: resolved.scope, base: resolved.base })
  const prompt = await loadPrompt('stop-review-gate', {
    CWD: root, SCOPE: resolved.scope, BASE_NOTE: '', DIFF: diff.text,
  })

  const { jobId, done } = await startJob({
    ccSessionId, verb: 'gate', prompt, cwd: root,
    agent: REVIEW_AGENT, tools: REVIEW_TOOLS,
  })
  await done
  const parsed = parseReviewOutput((await readResult(jobId)) ?? '')
  if (!parsed.ok) return null

  const blocking = parsed.findings.filter(f => BLOCKING.has(f.severity))
  if (!blocking.length) return null

  const lines = ['opencode found blocking issues in the working tree:', '']
  for (const f of blocking) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.file}${f.line ? `:${f.line}` : ''}${f.title ? ` — ${f.title}` : ''}`)
    for (const l of f.body.split('\n')) lines.push(`    ${l}`)
    lines.push('')
  }
  lines.push('Address these or explain why they are acceptable before finishing.')
  return { decision: 'block', reason: lines.join('\n') }
}

try {
  const decision = await gate()
  if (decision) process.stdout.write(JSON.stringify(decision) + '\n')
} catch (err) {
  // The gate must never wedge a session. Report and let the turn finish.
  process.stderr.write(`opencode-plugin-cc stop gate: ${err.message}\n`)
}
process.exit(0)
```

- [ ] **Step 5: Write `hooks/hooks.json`**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionStart",
            "timeout": 20
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionEnd",
            "timeout": 20
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs\"",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/integration/hooks.test.mjs`
Expected: PASS, 9 tests

- [ ] **Step 7: Commit**

```bash
git add hooks/hooks.json scripts/session-lifecycle-hook.mjs scripts/stop-review-gate-hook.mjs tests/integration/hooks.test.mjs
git commit -m "feat: session lifecycle hooks and an opt-in Stop review gate"
```

---

## Task 19: Command markdown, skills, and the command lint

Command files are prompts, not code. The lint is what keeps them honest.

**Files:**
- Create: `commands/review.md`, `commands/adversarial-review.md`, `commands/rescue.md`, `commands/transfer.md`, `commands/status.md`, `commands/result.md`, `commands/cancel.md`, `commands/setup.md`, `skills/opencode-server-runtime/SKILL.md`, `skills/opencode-result-handling/SKILL.md`
- Modify: `tests/lint-commands.test.mjs`

**Interfaces:**
- Consumes: `VERBS` exported from `scripts/opencode-companion.mjs`.
- Produces: eight commands whose every `Bash(...)`-invoked companion verb exists.

- [ ] **Step 1: Write the failing lint**

Replace `tests/lint-commands.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { VERBS } from '../scripts/opencode-companion.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

async function markdownFiles() {
  const out = []
  for (const dir of ['commands', 'agents']) {
    for (const f of await readdir(root + dir)) {
      if (f.endsWith('.md')) out.push({ path: `${dir}/${f}`, text: await readFile(root + dir + '/' + f, 'utf8') })
    }
  }
  return out
}

test('all eight commands ship', async () => {
  const files = (await readdir(root + 'commands')).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort()
  assert.deepEqual(files, ['adversarial-review', 'cancel', 'rescue', 'result', 'review', 'setup', 'status', 'transfer'])
})

test('every companion verb named in a command or agent actually exists', async () => {
  const pattern = /opencode-companion\.mjs\s+([a-z][a-z-]*)/g
  for (const { path, text } of await markdownFiles()) {
    for (const m of text.matchAll(pattern)) {
      assert.ok(VERBS.includes(m[1]), `${path} invokes companion verb "${m[1]}" which the companion does not implement (implemented: ${VERBS.join(', ')})`)
    }
  }
})

test('every command tells Claude to return companion stdout verbatim', async () => {
  for (const { path, text } of await markdownFiles()) {
    if (!path.startsWith('commands/')) continue
    assert.match(text, /verbatim/i, `${path} must state that companion output is returned verbatim`)
  }
})

test('each command has YAML frontmatter with a description', async () => {
  for (const { path, text } of await markdownFiles()) {
    assert.match(text, /^---\n[\s\S]*?\ndescription:/, `${path} needs frontmatter with a description`)
  }
})

test('the rescue command routes through the opencode-rescue subagent', async () => {
  const text = await readFile(root + 'commands/rescue.md', 'utf8')
  assert.match(text, /opencode-rescue/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/lint-commands.test.mjs`
Expected: FAIL — the commands directory is empty

- [ ] **Step 3: Write `commands/review.md`**

```markdown
---
description: Review the current change with opencode. Review only — nothing is fixed.
argument-hint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]"
allowed-tools: Bash, AskUserQuestion
---

Delegate a code review of the current change to opencode. You do not review the
code yourself and you do not fix anything.

Arguments: $ARGUMENTS

**1. Size the change first.**

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review-size --json` with any `--base` or `--scope` the user gave.

The JSON tells you `scope`, `empty`, `tiny`, `files`, and `untracked`. Untracked
files and directories are reviewable work. Conclude there is nothing to review
only when `empty` is `true`; when in doubt, run the review.

**2. Decide wait vs background.**

- If the user passed `--wait` or `--background`, obey it without asking.
- Otherwise, if `tiny` is `true`, recommend *wait*.
- In every other case — including unclear size — recommend *background*.

Ask once with `AskUserQuestion`, with the recommended option first and labelled
`(Recommended)`. Do not ask twice and do not ask when the flag was given.

**3. Run it.**

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review --wait` (or `--background`),
passing through any `--base`, `--scope`, `--model`, and `--variant` the user gave.

**4. Return the output verbatim.**

Print the companion's stdout exactly as it came back. Do not summarize it, do not
re-rank the findings, do not add your own commentary, and do not act on the
findings unless the user asks you to.
```

- [ ] **Step 4: Write `commands/adversarial-review.md`**

Same structure, with these differences stated explicitly: it invokes
`adversarial-review` instead of `review`, it accepts free-form focus text which is
passed after `--`, and its purpose line reads "challenges the change's design
decisions, premises, and assumptions, not only its defects." It carries the same
verbatim-output rule and the same wait/background decision procedure (repeat the
procedure in full — do not write "same as review").

- [ ] **Step 5: Write `commands/rescue.md`**

```markdown
---
description: Hand a coding task to opencode, which runs with write access.
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <m>] [--variant <v>] [task]"
allowed-tools: Bash, Agent, AskUserQuestion
---

Hand a coding task to opencode. opencode runs with write access here — that is
the point of rescue.

Arguments: $ARGUMENTS

**1. Decide whether to continue a prior thread.**

If the user passed `--resume` or `--fresh`, obey it and skip this step.

Otherwise run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task-resume-candidate --json`

If `hasCandidate` is `true`, ask once with `AskUserQuestion` whether to continue
that opencode thread or start a new one. Order the options by how the task text
reads: put *continue* first when it reads as a follow-up ("continue", "keep
going", "dig deeper", "also"), and *fresh* first when it reads as a new task.

**2. Dispatch to the subagent.**

Use the `Agent` tool with `subagent_type: "opencode-rescue"`. Give it exactly one
instruction: run

`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task --wait [--resume|--fresh] [--model <m>] [--variant <v>] -- <task text>`

and return stdout unchanged. Use `--background` instead of `--wait` only if the
user asked for it. Default is foreground.

**3. Return the output verbatim.**

Print the subagent's output exactly as it came back. Do not summarize, reformat,
or continue the work yourself. Model and variant stay unset unless the user
explicitly asked for them.
```

- [ ] **Step 6: Write the remaining five commands**

`commands/transfer.md` — frontmatter `description: Export this conversation into a
new opencode session (one-way).`, `allowed-tools: Bash`. Body: run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" transfer`, print stdout verbatim, and
state plainly that this is a one-way export: work done in opencode does not come
back to this session.

`commands/status.md` — runs `... status`, prints stdout verbatim, adds nothing.

`commands/result.md` — `argument-hint: "<jobId>"`; runs `... result <jobId>`,
prints stdout verbatim. If the user gave no job id, run `... status` first and ask
which job with `AskUserQuestion`.

`commands/cancel.md` — `argument-hint: "<jobId>|--all"`; runs `... cancel <arg>`,
prints stdout verbatim.

`commands/setup.md` — `allowed-tools: Bash, AskUserQuestion`, and the full
onboarding procedure:

```markdown
---
description: Check and configure opencode for this plugin — binary, credentials, model, and server.
argument-hint: "[--gate on|off] [--status] [--repair]"
allowed-tools: Bash, AskUserQuestion
---

Arguments: $ARGUMENTS

If the user passed `--gate on|off`, run `... gate --on` or `... gate --off`, print
stdout verbatim, and stop. If they passed `--status`, run `... doctor` and print
stdout verbatim, and stop. If they passed `--repair`, run `... repair`, print
stdout verbatim, and stop.

Otherwise run the full onboarding:

**1. Diagnose.** Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" doctor --json`

Read the report. If `ok` is true, print `... doctor` output verbatim and stop —
everything is already configured.

**2. Binary gap.** If `binary.ok` is false, tell the user how to install opencode
for their platform and stop. Do not attempt the install yourself.

**3. Auth gap.** If `auth.ok` is false, ask with `AskUserQuestion` which provider
to configure. Present already-reachable options first, in this order: a provider
already listed in `auth.providers`; a provider named in `auth.envHints` (its key
is already in the environment); a local Ollama if `http://127.0.0.1:11434` answers.

For an API-key provider, print the provider's key page URL, note that credentials
live in `~/.local/share/opencode/auth.json`, and give the user this exact command
to run themselves with a `!` prefix so the output lands in the conversation:

`!node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" set-key --provider <provider> --key <API_KEY>`

Never ask the user to paste the key to you, never read `auth.json`, and never
echo a key. For OAuth or device-code providers, tell them to run
`opencode auth login` interactively instead.

**4. Model gap.** If `model.ok` is false, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" models --provider <provider>` and ask with
`AskUserQuestion` which model to use, populating the options from that real list.
Then run:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" set-model --model <provider/model> --scope global`

Use `--scope project` instead only if the user asked for a repo-local setting.

**5. Verify.** `set-key` and `set-model` re-run doctor themselves. Print their
stdout verbatim. Never assert that setup succeeded on the basis of a write you
have not seen verified by a fresh doctor report.
```

- [ ] **Step 7: Write the two skills**

`skills/opencode-server-runtime/SKILL.md` — frontmatter `name:
opencode-server-runtime`, `description: Use when an opencode job hangs, the broker
will not start, a port is stuck, or job state looks wrong.` Body: explains the
broker model (spawn-once via lockfile + portfile at
`~/.local/state/opencode-plugin-cc/broker/`, refcounted per Claude Code session,
shut down when the last session releases it), what `repair` clears, that a dropped
SSE stream reconnects with backoff while the job continues server-side, and that
job records are namespaced per Claude Code session so another window's jobs are
invisible by design.

`skills/opencode-result-handling/SKILL.md` — frontmatter `name:
opencode-result-handling`, `description: Use when presenting opencode review or
task output to the user.` Body: companion stdout is returned verbatim — never
paraphrased, re-ranked, or summarized; unparseable model output is rendered raw
with a note and must still be shown in full; findings are opencode's opinion, not
verdicts, and are not acted on unless the user asks; a background job's result is
retrieved with `/opencode:result <jobId>`, not by polling.

- [ ] **Step 8: Run the lint to verify it passes**

Run: `node --test tests/lint-commands.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add commands skills tests/lint-commands.test.mjs
git commit -m "feat: eight slash commands, two skills, and a prompt/code drift lint"
```

---

## Task 20: Isolated-real and live test suites

These run against the real binary. Isolated-real uses a throwaway `HOME` so the
developer's credentials are never at risk; live is opt-in and spends tokens.

**Files:**
- Create: `tests/isolated/setup-ladder.test.mjs`, `tests/live/smoke.test.mjs`
- Modify: `README.md` (document how to run each suite)

**Interfaces:**
- Consumes: the whole companion CLI.
- Produces: `npm run test:isolated` and `OPENCODE_LIVE=1 npm run test:live`.

- [ ] **Step 1: Write `tests/isolated/setup-ladder.test.mjs`**

```js
import { test, skip } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat, access } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'

const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const realBin = process.env.OPENCODE_BIN || join(homedir(), '.opencode', 'bin', 'opencode')

const haveRealBinary = await access(realBin).then(() => true, () => false)

// A throwaway HOME with no auth.json and no opencode.json — the developer's real
// credentials are never touched by this suite.
async function isolated(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ociso-'))
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: realBin,
    CLAUDE_SESSION_ID: 'cc-iso',
    ...extra,
  }
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  return { env, home }
}

const cli = (env, args, cwd) => run(process.execPath, [companion, ...args], { env, cwd, timeoutMs: 120000 })

test('fresh install: doctor names the auth gap against the real binary', { skip: !haveRealBinary && 'no real opencode binary' }, async () => {
  const s = await isolated()
  const r = await cli(s.env, ['doctor', '--json'])
  const report = JSON.parse(r.stdout)
  assert.equal(report.binary.ok, true)
  assert.equal(report.version.ok, true, `version ${report.version.value} is below the floor`)
  assert.equal(report.auth.ok, false)
  assert.match(report.gaps.join(' '), /credentials/)
})

test('auth present, model missing: exactly one gap, and it names the model', { skip: !haveRealBinary && 'no real opencode binary' }, async () => {
  const s = await isolated()
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), JSON.stringify({ openrouter: { type: 'api', key: 'sk-placeholder' } }), { mode: 0o600 })
  const r = await cli(s.env, ['doctor', '--json', '--no-server'])
  const report = JSON.parse(r.stdout)
  assert.equal(report.auth.ok, true)
  assert.equal(report.model.ok, false)
  assert.deepEqual(report.gaps.filter(g => /model/.test(g)).length, 1)
})

test('set-key writes a real auth.json at 0600 without clobbering siblings', { skip: !haveRealBinary && 'no real opencode binary' }, async () => {
  const s = await isolated()
  const authPath = join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json')
  await writeFile(authPath, JSON.stringify({ anthropic: { type: 'api', key: 'KEEP' } }), { mode: 0o600 })
  const r = await cli(s.env, ['set-key', '--provider', 'openrouter', '--key', 'sk-or-test1234'])
  assert.equal(r.code, 0)
  assert.equal(r.stdout.includes('sk-or-test1234'), false)
  const out = JSON.parse(await readFile(authPath, 'utf8'))
  assert.equal(out.anthropic.key, 'KEEP')
  assert.equal(out.openrouter.key, 'sk-or-test1234')
  assert.equal((await stat(authPath)).mode & 0o777, 0o600)
})

test('set-model writes a real config and doctor confirms it on re-run', { skip: !haveRealBinary && 'no real opencode binary' }, async () => {
  const s = await isolated()
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), JSON.stringify({ openrouter: { type: 'api', key: 'sk-placeholder' } }), { mode: 0o600 })
  const set = await cli(s.env, ['set-model', '--model', 'openrouter/openai/gpt-oss-20b:free'])
  assert.equal(set.code, 0)
  const report = JSON.parse((await cli(s.env, ['doctor', '--json', '--no-server'])).stdout)
  assert.equal(report.model.ok, true)
  assert.equal(report.model.source, 'global')
})

test('a model whose provider has no credential still leaves setup a path forward', { skip: !haveRealBinary && 'no real opencode binary' }, async () => {
  const s = await isolated()
  await cli(s.env, ['set-model', '--model', 'anthropic/claude-sonnet-5'])
  const report = JSON.parse((await cli(s.env, ['doctor', '--json', '--no-server'])).stdout)
  assert.equal(report.model.ok, true)
  assert.equal(report.auth.ok, false)
  assert.match(report.gaps.join(' '), /credentials/)
})

test('the real server starts and answers the doctor server check', { skip: !haveRealBinary && 'no real opencode binary' }, async () => {
  const s = await isolated()
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), JSON.stringify({ openrouter: { type: 'api', key: 'sk-placeholder' } }), { mode: 0o600 })
  await cli(s.env, ['set-model', '--model', 'openrouter/openai/gpt-oss-20b:free'])
  const report = JSON.parse((await cli(s.env, ['doctor', '--json'])).stdout)
  assert.equal(report.server.ok, true, report.server.detail)
  await cli(s.env, ['repair'])
})
```

- [ ] **Step 2: Add `--no-server` support and run the isolated suite**

`--no-server` already works: `parseArgs` turns it into `flags.server === false`,
and the doctor handler passes `checkServer: flags.server !== false`.

Run: `npm run test:isolated`
Expected: PASS, 6 tests. If the real binary is absent, every test reports as
skipped rather than failing.

- [ ] **Step 3: Write `tests/live/smoke.test.mjs`**

One review and one rescue against the developer's real credentials on a cheap
model, kept small, opt-in only.

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'

const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const live = process.env.OPENCODE_LIVE === '1'
const model = process.env.OPENCODE_LIVE_MODEL || 'openrouter/openai/gpt-oss-20b:free'

async function repo() {
  const d = await mkdtemp(join(tmpdir(), 'oclive-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' }
  const git = (...a) => run('git', a, { cwd: d, env })
  await git('init', '-b', 'main')
  await writeFile(join(d, 'div.js'), 'export function div(a, b) { return a / b }\n')
  await git('add', '.')
  await git('commit', '-m', 'init')
  return d
}

test('live: a real review returns findings or a clean report', { skip: !live && 'set OPENCODE_LIVE=1 to run' }, async () => {
  const d = await repo()
  await writeFile(join(d, 'div.js'), 'export function div(a, b) { return a / b }\nexport const half = (n) => div(n, 0)\n')
  const r = await run(process.execPath, [companion, 'review', '--wait', '--model', model], {
    cwd: d,
    env: { ...process.env, CLAUDE_SESSION_ID: 'cc-live' },
    timeoutMs: 300000,
  })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /opencode review/)
  assert.ok(r.stdout.length > 40, 'the review produced no meaningful output')
})

test('live: a real task returns model output', { skip: !live && 'set OPENCODE_LIVE=1 to run' }, async () => {
  const d = await repo()
  const r = await run(process.execPath, [companion, 'task', '--wait', '--model', model, '--', 'Reply with the single word: ready'], {
    cwd: d,
    env: { ...process.env, CLAUDE_SESSION_ID: 'cc-live' },
    timeoutMs: 300000,
  })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout.toLowerCase(), /ready/)
})
```

- [ ] **Step 4: Run the live suite once, deliberately**

Run: `OPENCODE_LIVE=1 npm run test:live`
Expected: PASS, 2 tests. This spends real tokens — run it once here, then leave it
opt-in. If the configured model rejects the request, set `OPENCODE_LIVE_MODEL` to
a model the developer's provider actually serves and re-run.

- [ ] **Step 5: Document the three suites in `README.md`**

Add a Testing section:

```markdown
## Testing

| Command | What it runs | Cost |
|---|---|---|
| `npm test` | Unit + integration against a fake opencode binary | free, no network |
| `npm run test:isolated` | The real binary in a throwaway HOME with no credentials | free, no tokens |
| `OPENCODE_LIVE=1 npm run test:live` | One review and one task against real credentials | spends tokens |

`npm test` is the suite to run on every change. The isolated suite exercises the
doctor ladder, `set-key`, and `set-model` against real opencode without touching
your credentials. The live suite is opt-in.
```

- [ ] **Step 6: Run everything**

Run: `npm test && npm run test:isolated`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add tests/isolated tests/live README.md
git commit -m "test: isolated-real setup ladder and opt-in live smoke suites"
```

---

## Self-review notes

Checked while writing, recorded so the implementer knows they were considered:

- **Spec coverage.** §3 → Task 1. §4.1 → the File Structure table. §4.2 → Tasks 7–9.
  §4.3 → Tasks 2–11 (three modules added; see "Additions" above). §4.4 → Task 4.
  §4.5 → Task 4's `buildRunArgs`, plus `REVIEW_TOOLS` in Task 14 which enforces the
  same denial server-side. §4.6 → Task 14 (review agent + schema), Task 7 (HTTP+SSE),
  Task 15 (`--session`), Task 13 (setup), Task 4 (`--variant`/`--effort`).
  §5.1–5.2 → Task 14. §5.3 → Task 15. §5.4 → Task 16. §5.5 → Task 17. §5.6 → Task 18.
  §6 → Tasks 12, 13, 19. §7 → Task 12 (gaps), Task 8 (broker retry, orphans), Task 9
  (SSE reconnect, cancel), Task 11 (raw render), Task 9 (`pruneStale`).
  §8.1 → Task 20. §8.2 → Task 20. §8.3 → Task 6. §8.4 → Tasks 2, 4, 5, 10, 11.
  §8.5 → Task 19.
- **One spec behavior is implemented differently than written.** §4.5 lists `--auto`
  and `--pure` as CLI flags, but the companion drives the server API rather than
  `opencode run`. The equivalent is: permissions come from the agent definition plus
  the explicit `tools` map on `prompt_async` (Task 14), which is strictly stronger than
  `--auto` — it denies write and shell at the request level rather than relying on the
  agent file being installed. `buildRunArgs` still implements the full flag mapping
  and is unit-tested, because `transfer` prints an `opencode --session <id>` resume
  command and a future direct-CLI path may need it.
- **Naming consistency.** `ccSessionId` (camel) is the parameter everywhere;
  `ccSessionId` on job records too. Job state values are exactly
  `running|done|failed|cancelled|stale` in Tasks 9, 17, and 18. `prepareReview`
  returns `root`, and Task 14's `reviewVerb` uses `prep.root` for `cwd`.
- **Known ordering dependency.** Task 17 Step 4 modifies `startJob` from Task 9 to
  accept `meta`. Do not skip it — `result` on a background review depends on the
  recorded scope.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-02-opencode-plugin-cc.md`.
