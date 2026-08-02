# opencode-plugin-cc — Design

Date: 2026-08-02
Status: Approved for planning

## 1. Purpose

A Claude Code plugin that delegates code review and coding tasks to the `opencode`
CLI, so a Claude Code user can get a second engine's review or hand off work without
leaving the session.

It is a direct analogue of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
with the delegated engine swapped from Codex to opencode. The host stays Claude Code;
the name follows the same `<engine>-plugin-cc` pattern.

### Non-goals (v1)

- The opposite direction (an opencode plugin that calls `claude`).
- Live bidirectional session sync. `transfer` is a one-way export.
- Bundling, proxying, or brokering provider API keys.
- Replacing or wrapping the opencode TUI.
- Installing a plugin on the opencode side.
- CI / GitHub Action integration.
- Telemetry of any kind.

## 2. Verified environment

Facts confirmed on the development machine on 2026-08-02. The design depends on
these; re-verify if the floor version moves.

| Fact | Value |
|---|---|
| opencode version | 1.18.11 |
| Install path | `~/.opencode/bin/opencode` — **not on PATH** in a non-login shell |
| Credentials | `~/.local/share/opencode/auth.json`, mode 0600. OpenRouter configured |
| Global config | `~/.config/opencode/opencode.json` **absent** → no default `model` |
| Models available | 343, listed as `provider/model` strings by `opencode models` |

Relevant `opencode run` flags (verified from `--help`):

`-c/--continue`, `-s/--session <id>`, `--fork`, `-m/--model provider/model`,
`--agent <name>`, `--format default|json`, `--attach <url>`, `--port`,
`--variant <effort>`, `--auto`, `--pure`, `--dir <path>`, `-f/--file`, `--title`.

`opencode serve` flags: `--port` (default `0` = ephemeral), `--hostname`
(default `127.0.0.1`), `--cors`, `--mdns`.

Server endpoints used: `GET /doc`, `POST /session`, `POST /session/:id/message`,
`POST /session/:id/prompt_async`, `GET /global/event` (SSE),
`POST /session/:id/abort`.

Two consequences are load-bearing:

- **Binary resolution is mandatory.** `opencode` is absent from PATH in the
  non-login shells that hooks and `Bash` calls run in. Assuming PATH would fail on
  the first call.
- **The dev machine is already the "unconfigured model" case.** Auth is present,
  default model is not. The setup flow is exercised for real on first run.

## 3. Identity and distribution

- Repository: `opencode-plugin-cc`
- Claude Code plugin name: `opencode` → commands namespace as `/opencode:<verb>`
- Installed via `/plugin marketplace add <repo>`; ships `.claude-plugin/marketplace.json`
- **Zero runtime dependencies.** Plain Node `.mjs`, built-in `fetch`, no install
  step, no build artifacts. Same posture as codex-plugin-cc.

## 4. Architecture

### 4.1 Layout

```
.claude-plugin/  plugin.json  marketplace.json
commands/        review.md adversarial-review.md rescue.md transfer.md
                 status.md result.md cancel.md setup.md
agents/          opencode-rescue.md
skills/          opencode-server-runtime/SKILL.md
                 opencode-result-handling/SKILL.md
hooks/           hooks.json
prompts/         review.md adversarial-review.md stop-review-gate.md
schemas/         review-output.schema.json
scripts/         opencode-companion.mjs
                 server-broker.mjs
                 session-lifecycle-hook.mjs
                 stop-review-gate-hook.mjs
scripts/lib/     opencode.mjs server.mjs server-protocol.d.ts
                 broker-lifecycle.mjs broker-endpoint.mjs
                 job-control.mjs tracked-jobs.mjs state.mjs
                 render.mjs git.mjs process.mjs args.mjs
                 prompts.mjs fs.mjs claude-session-transfer.mjs
tests/           fake-opencode-fixture.mjs  unit/  integration/  isolated/
```

### 4.2 Data flow

```
/opencode:review
    │  (commands/review.md — prompt-level policy: scope, wait vs background)
    ▼  Bash
opencode-companion.mjs review [flags]
    │  ensure-broker (spawn-once: lockfile + portfile)
    ▼
server-broker.mjs ──▶ opencode serve --port 0 --hostname 127.0.0.1
    │
    ├─ HTTP  POST /session                  → sessionID
    ├─ HTTP  POST /session/:id/prompt_async → job starts
    ├─ SSE   GET  /global/event             → progress, tool calls, tokens
    └─ HTTP  POST /session/:id/abort        → cancel
    ▼
state dir ~/.local/state/opencode-plugin-cc/
    jobs/<jobId>/{meta.json, events.jsonl, result.md}
    broker/{port, pid, lock}
    sessions/<cc-session-id> → last opencode sessionID
```

`opencode-companion.mjs` is the single entrypoint every command invokes. The broker
is an implementation detail it starts lazily and reaps when the last session
releases it.

### 4.3 Module responsibilities

Each module has one job and a documented interface, so it can be understood and
tested without reading its consumers.

| Module | Responsibility |
|---|---|
| `opencode.mjs` | Resolve and describe the binary; build argv; own flag mapping |
| `server.mjs` | HTTP + SSE client for the endpoints above. No job semantics |
| `server-protocol.d.ts` | Hand-written wire types for request/response/event shapes |
| `broker-lifecycle.mjs` | Spawn-once, refcount, health-check, shutdown, orphan reaping |
| `broker-endpoint.mjs` | Read/write the portfile; resolve base URL |
| `job-control.mjs` | Start / observe / cancel a job. Bridges server + state |
| `tracked-jobs.mjs` | Job records scoped to a Claude Code session |
| `state.mjs` | Atomic reads/writes under the state dir |
| `render.mjs` | Terminal rendering of review findings and job status |
| `git.mjs` | Diff collection, scope resolution, change sizing |
| `process.mjs` | Spawn, timeout, signal handling |
| `args.mjs` | Parse companion argv |
| `prompts.mjs` | Load prompt templates from `prompts/` |
| `fs.mjs` | Atomic write, backup, mode-preserving merge-write |
| `claude-session-transfer.mjs` | Snapshot the CC conversation for `transfer` |

### 4.4 Binary resolution

`lib/opencode.mjs` resolves in order and caches the first hit:

1. `$OPENCODE_BIN`
2. PATH
3. `~/.opencode/bin/opencode`
4. `~/.local/bin/opencode`
5. `/opt/homebrew/bin/opencode`, `/usr/local/bin/opencode`
6. `~/.bun/bin/opencode`

`doctor` reports which path was used, so a wrong-binary situation is diagnosable.

### 4.5 Flag mapping

| Plugin concept | opencode flag | Notes |
|---|---|---|
| reasoning effort | `--variant <v>` | provider-specific; passed through unvalidated. `--effort` is accepted as an alias for users coming from codex-plugin-cc |
| model | `-m provider/model` | unset unless the user asks |
| agent | `--agent <name>` | review and rescue agents |
| resume thread | `-s <sessionID>` / `-c` | |
| fresh thread | omit both | |
| working directory | `--dir <repo>` | always set explicitly |
| headless permissions | `--auto` | **required**; see below |
| hermetic test run | `--pure` | excludes the user's own opencode plugins |

`--auto` auto-approves permissions that are not explicitly denied. It is required
for headless jobs — without it a background job blocks forever on a prompt nobody
can see. Safety comes from the agent definition, not from the prompt loop: the
review agent denies `edit` and `bash`, so auto-approval grants nothing dangerous.
Rescue runs with write access by design, which is the point of rescue.

### 4.6 Divergences from codex-plugin-cc

| Codex | opencode | Resolution |
|---|---|---|
| native `codex review` mode | no built-in reviewer | ship a review agent (`edit: deny`, `bash: deny`) plus a prompt that emits JSON matching `schemas/review-output.schema.json` |
| app-server JSON-RPC | HTTP + SSE | `lib/server.mjs`; wire types hand-written |
| `--resume` thread | `--session` / `--fork` | same semantics, IDs persisted per CC session |
| auth assumed present | 75+ providers, often unconfigured | `/opencode:setup` performs real onboarding (§6) |
| `--effort` | `--variant` | direct mapping |

## 5. Commands

All eight commands from codex-plugin-cc ship in v1. Every command returns companion
stdout **verbatim** — no paraphrase, summary, or added commentary.

### 5.1 `/opencode:review`

`[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]`

Review-only. The command prompt forbids fixing anything.

Scope resolution: `auto` → branch diff when HEAD is ahead of its base, else working
tree. Sizing before the wait/background question uses `git status --short
--untracked-files=all`, `git diff --shortstat --cached`, `git diff --shortstat`, or
`git diff --shortstat <base>...HEAD`. Untracked files and directories count as
reviewable work even when `git diff --shortstat` is empty. Conclude there is nothing
to review only when the relevant status is genuinely empty; when in doubt, run the
review.

Execution mode: `--wait` and `--background` are obeyed without asking. Otherwise
recommend *wait* only for a clearly tiny change (~1–2 files, no directory-sized
edit) and *background* in every other case including unclear size, then ask once
with `AskUserQuestion`, recommended option first and labelled `(Recommended)`.

The companion collects the diff itself and sends it as the prompt payload, so the
model never needs `bash` to see the change; `read` stays available for surrounding
context. Output is validated against
`schemas/review-output.schema.json` (findings: file, line, severity, confidence,
body) and rendered by `render.mjs`. Unparseable output is rendered raw with a note —
never discarded.

No staged-only or unstaged-only review, and no extra focus text; that is
`adversarial-review`'s job.

### 5.2 `/opencode:adversarial-review`

Same pipeline, `prompts/adversarial-review.md` instead: challenges design decisions,
premises, and assumptions rather than only defects. Accepts free-form focus text.

### 5.3 `/opencode:rescue`

`[--background|--wait] [--resume|--fresh] [--model <m>] [--variant <v>] [task]`

Routes to the `opencode-rescue` subagent via the `Agent` tool. That subagent is a
thin forwarder: one `Bash` call to `opencode-companion.mjs task ...`, return stdout
as-is. It does not inspect files, poll status, fetch results, or do follow-up work.

Default execution is foreground. Unless `--resume` or `--fresh` is given, the command
first runs `task-resume-candidate --json`; when a prior opencode session exists for
this Claude Code session it asks once whether to continue that thread or start a new
one, ordering the options by whether the phrasing reads as a follow-up ("continue",
"keep going", "dig deeper") or a new task.

Rescue runs with write permissions. Model and variant stay unset unless the user
explicitly asks.

### 5.4 `/opencode:transfer`

Snapshots the current Claude Code conversation, writes a handoff file, creates an
opencode session seeded with it, and prints the session ID plus the exact
`opencode --session <id>` command to resume natively. One-way export.

### 5.5 Job control

- `status` — jobs for this CC session: id, verb, state, elapsed, step and token
  counters read from the SSE tail.
- `result <jobId>` — rendered output of a finished job, or the partial tail with a
  "still running" banner.
- `cancel <jobId|--all>` — `POST /session/:id/abort`, then SIGTERM the tracked
  process if it does not settle within a grace period.

Job records are namespaced per Claude Code session: a second Claude window neither
sees nor cancels another window's jobs. Stale records are pruned at `SessionStart`.

### 5.6 Hooks

| Hook | Behavior |
|---|---|
| `SessionStart` | Register the CC session; prune dead job records |
| `SessionEnd` | Cancel this session's running jobs; release the broker, shutting it down if last |
| `Stop` | Optional review gate, **off by default**, toggled by `/opencode:setup --gate on`. Reviews the working tree before Claude finishes a turn and surfaces blocking findings |

## 6. `/opencode:setup`

The largest divergence from codex-plugin-cc, which only checks that the binary
exists and is logged in.

### 6.1 Preflight ladder

`opencode-companion.mjs doctor --json` returns a structured report. Every other
command calls it first and stops with a specific gap plus "run `/opencode:setup`"
rather than a stack trace.

1. **Binary** — resolve per §4.4, run `--version`, compare against the declared
   floor (1.18.0). Missing → platform install instructions.
2. **Auth** — parse `opencode auth list`; cross-check provider env vars already
   present in the environment.
3. **Model** — resolve the effective default: project `opencode.json` → global
   `~/.config/opencode/opencode.json`. Absent → unconfigured.
4. **Server** — start `opencode serve` and reach `GET /doc`. Catches port and
   sandbox problems before a job hangs silently.

### 6.2 Guided onboarding

When auth or model is unconfigured, setup walks the user through it rather than
failing.

Claude reads the doctor report and asks via `AskUserQuestion` which provider to use,
presenting already-reachable options first: an existing `auth.json` entry, a
provider API key already in the environment, or a local Ollama on `:11434`. It then
asks which model, with choices populated from `opencode models <provider>` so the
list is real rather than remembered.

**When a key is needed**, Claude prints where credentials live
(`~/.local/share/opencode/auth.json`), a link to that provider's key page, and a
ready-to-run command with a placeholder:

```
opencode-companion.mjs set-key --provider <provider> --key <API_KEY>
```

The user substitutes the key and runs it — in-session by prefixing `!`, so the
output lands in the conversation and Claude can verify immediately.

`set-key` requirements:

- Merge into `auth.json`; never clobber other providers.
- Back up the previous file before writing.
- Write atomically at mode `0600`.
- Print only a redacted confirmation.

Claude never requests, reads back, or echoes the key. For OAuth and device-code
providers where a raw key does not apply, setup offers the interactive
`opencode auth login` path instead.

**Model selection** is written by `set-model --scope global|project`, a merge-write
of the `model` field into the correct `opencode.json`, creating the file with its
`$schema` line if absent. Setup then re-runs `doctor` and reports the result, so a
green status is never asserted on the basis of an unverified write.

### 6.3 Other setup verbs

- `--gate on|off` — toggle the `Stop` review gate.
- `--status` — doctor report as a readable table.
- `--repair` — clear a stale broker portfile/lock and orphaned job records.

## 7. Failure handling

| Situation | Behavior |
|---|---|
| Binary missing / too old / unauthenticated / no model | Stop before any work, name the specific gap, point at `/opencode:setup` |
| Broker will not start, or port bound | Retry on a fresh ephemeral port, then fail with the server's stderr |
| SSE drops mid-job | Reconnect with backoff; the job continues server-side, events resume from the persisted tail |
| Model output is not valid review JSON | Render raw with a note. Never discard a paid result over a parse failure |
| Job killed, or machine slept | Marked `stale` at next `SessionStart`; partial output retrievable via `result` |
| Two Claude Code windows | Refcounted shared broker, per-session job namespaces |

Errors are a non-zero exit code plus a human-readable message on stderr. Nothing is
swallowed.

## 8. Testing

Three environments. `node --test`, no framework.

### 8.1 Live

Real binary, the developer's real credentials, a cheap model, `--pure`. One review
and one rescue per suite run, kept small. Opt-in via `OPENCODE_LIVE=1` so routine
runs and CI do not spend tokens. Answers "does this actually work".

### 8.2 Isolated-real

Real binary, temporary `HOME`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME`; no
`auth.json`, no `opencode.json`. Covers, against real opencode and with zero risk to
the developer's credentials:

- Fresh install: nothing configured at all.
- Auth present, default model missing (the dev machine's current state).
- User asks for a model whose provider has no credential — assert setup guides
  rather than crashes.
- The doctor ladder, the setup walkthrough, `set-key` and `set-model` writes, and
  post-write re-verification.

### 8.3 Fake fixture

`tests/fake-opencode-fixture.mjs` impersonates the binary and is placed first on
PATH; the companion runs unmodified against it. It implements `--version`,
`auth list`, `models`, and `serve` — where `serve` stands up a real HTTP server
providing `/doc`, `POST /session`, `POST /session/:id/prompt_async`,
`GET /global/event` (SSE), and `POST /session/:id/abort`, replaying scripted event
sequences.

Fixture fault modes: binary missing, version too old, slow start, mid-SSE
disconnect, malformed JSON, non-zero exit, port already bound, orphaned lockfile.

### 8.4 Unit coverage

Argument parsing, scope resolution, diff sizing, `render.mjs` output, schema
validation, and — most heavily — the credential and config writers: merge preserves
siblings, mode is `0600`, writes are atomic, backups are taken. That is where silent
data loss would live.

### 8.5 Command lint

Command files are markdown prompts and cannot be unit-tested. A lint check asserts
that every `Bash(...)` invocation appearing in `commands/` and `agents/` names a verb
the companion actually implements, so prompts and code cannot drift apart.

## 9. Open questions

None. Ready for planning.
