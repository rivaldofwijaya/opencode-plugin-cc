# opencode-plugin-cc

The opencode Claude Code plugin delegates code review and coding tasks to the
opencode CLI. Install it with `/plugin marketplace add <repo>`, use opencode
1.18.0 or newer, and run `/opencode:setup` first.

The main user-facing commands are `/opencode:review`,
`/opencode:adversarial-review`, `/opencode:rescue`, `/opencode:transfer`,
`/opencode:status`, `/opencode:result`, `/opencode:cancel`, and
`/opencode:setup`.

Runtime state is stored under
`${XDG_STATE_HOME:-$HOME/.local/state}/opencode-plugin-cc/`. Credentials are
stored by opencode under
`${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json`.

## File structure

- `.gitignore` — ignores local dependencies, logs, and operating-system files.
- `README.md` — this project overview and file map.
- `commands/` — the eight Claude Code slash-command prompts.
- `skills/opencode-server-runtime/SKILL.md` — broker and durable-job recovery guidance.
- `skills/opencode-result-handling/SKILL.md` — output-preservation guidance.
- `agents/opencode-rescue.md` — the write-capable rescue forwarder.
- `agents/opencode-review.md` — the Claude Code read-only review subagent definition; it is not installed into opencode.
- `scripts/opencode-companion.mjs` — the companion CLI entrypoint.
- `scripts/lib/doctor.mjs` — binary, credential, model, and server checks.
- `scripts/lib/gate.mjs` — Stop review gate state.
- `scripts/lib/review-job.mjs` — review preparation and result finishing.
- `scripts/lib/hook-io.mjs` — shared hook input/output helpers.
- `tests/fixture-bin/opencode` — the test-only opencode executable shim.

## Testing

| Command | What it runs | Cost |
|---|---|---|
| `npm test` | Unit + integration against a fake opencode binary | free, no network |
| `npm run test:isolated` | The real binary in a throwaway HOME with no credentials | free, no tokens |
| `OPENCODE_LIVE=1 npm run test:live` | Review, adversarial review, task, the background job lifecycle, the tool counter, and transfer against real credentials | spends tokens |

`npm test` is the suite to run on every change. The isolated suite exercises the
doctor ladder, `set-key`, and `set-model` against real opencode without touching
your credentials. The live suite is opt-in.

The live suite runs one file at a time; its tests share one broker, one state
root, and one `repair` sweep. `OPENCODE_LIVE_TOOL_MODEL` overrides the model for
the tool-counter test alone, for when the default model does not call tools
reliably. `OPENCODE_LIVE_MODEL` overrides the default model for the whole live
suite. The default free model intermittently returns empty output, which
surfaces as a review-JSON parse failure, so a stronger model is worth setting
when the live suite is used as a gate.
