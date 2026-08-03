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
- `agents/opencode-review.md` — the read-only review agent.
- `scripts/opencode-companion.mjs` — the companion CLI entrypoint.
- `scripts/lib/doctor.mjs` — binary, credential, model, and server checks.
- `scripts/lib/gate.mjs` — Stop review gate state.
- `scripts/lib/review-job.mjs` — review preparation and result finishing.
- `scripts/lib/hook-io.mjs` — shared hook input/output helpers.
- `tests/fixture-bin/opencode` — the test-only opencode executable shim.
