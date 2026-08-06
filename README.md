# opencode plugin for Claude Code

[![CI](https://github.com/rivaldofwijaya/opencode-plugin-cc/actions/workflows/ci.yml/badge.svg)](https://github.com/rivaldofwijaya/opencode-plugin-cc/actions/workflows/ci.yml)

Inspired by [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc),
which brings Codex into Claude Code. This project does the same job for
[opencode](https://opencode.ai) and is an independent effort — not affiliated
with OpenAI, Anthropic, or the opencode project.

Claude Code writes the code; opencode reads it back. The plugin hands review and
coding work to a second model running in its own process, so you get a genuinely
independent opinion instead of the same model grading its own homework. Jobs can
run in the foreground or in the background while you keep working.

## What you get

- `/opencode:review` — a second model reviews your change and reports findings by severity.
- `/opencode:adversarial-review` — challenges the premises and design of the change, not its syntax.
- `/opencode:rescue` — hands a coding task to opencode, which runs **with write access**.
- `/opencode:transfer` — exports the current conversation into a fresh opencode session.
- `/opencode:status` — lists this session's jobs.
- `/opencode:result` — prints a finished job's output.
- `/opencode:cancel` — stops a running job, or all of them.
- `/opencode:setup` — checks and configures the binary, credentials, model, and server.

## Requirements

- [opencode](https://opencode.ai) 1.18.0 or newer, on your `PATH`.
- Node.js 22 or newer.
- Credentials for at least one model provider. `/opencode:setup` walks you through it.

## Install

```
/plugin marketplace add rivaldofwijaya/opencode-plugin-cc
/plugin install opencode@opencode-plugin-cc
```

Then run setup once and follow what it asks for:

```
/opencode:setup
```

It reports on four things — binary, credentials, model, server — and stops at
the first gap with instructions rather than guessing. Re-run it any time; it is
also the repair path.

## Commands

### Review

```
/opencode:review
/opencode:review --base main
/opencode:review --background
```

Reviews the working tree by default, or a branch diff with `--base`. Findings
come back ordered critical → info. Nothing is fixed — this is review only.

### Adversarial review

```
/opencode:adversarial-review
/opencode:adversarial-review the caching layer
```

Argues with the change instead of proofreading it: wrong abstraction, unstated
assumption, a simpler design you passed over. Add a focus phrase to point it
somewhere specific.

### Rescue

```
/opencode:rescue port the parser to the new API
/opencode:rescue --background migrate the test suite
/opencode:rescue --fresh
```

Hands the task to opencode with write access. If you have a recent opencode
thread, it asks whether to continue that one or start fresh — or pass `--resume`
/ `--fresh` to skip the question. Output comes back verbatim.

### Transfer

```
/opencode:transfer
```

One-way export of the current conversation into a new opencode session. Work
done there does not come back.

> **Note:** transfer performs no redaction. Whatever is in the transcript,
> including anything sensitive, is sent to opencode.

### Jobs

```
/opencode:status
/opencode:result job_1a2b3c
/opencode:cancel job_1a2b3c
/opencode:cancel --all
```

Background jobs survive the command that started them. `status` is scoped to the
current Claude Code session; `cancel` kills the worker process, not just the
record.

## Typical flows

**Review before you commit**

```
/opencode:review --base main
```

**Get unstuck, then check the result**

```
/opencode:rescue --background rewrite the retry logic
/opencode:status
/opencode:result job_1a2b3c
```

**Pressure-test a design you already like**

```
/opencode:adversarial-review
```

## The Stop review gate

```
/opencode:setup --gate on
/opencode:setup --gate off
```

With the gate on, opencode reviews your change when Claude Code finishes a turn
and blocks on critical or high findings. Off by default.

## Choosing a model

`/opencode:setup` writes your model choice to opencode's own config, so it is
shared with the opencode CLI rather than duplicated here. Weak free models are
the most common source of disappointing reviews — they frequently return nothing
at all, which the plugin reports as "the model returned no output".

## Testing

| Command | What it runs | Cost |
|---|---|---|
| `npm test` | Unit + integration against a fake opencode binary | free, no network |
| `npm run test:isolated` | The real binary in a throwaway HOME with no credentials | free, no tokens |
| `OPENCODE_LIVE=1 npm run test:live` | Review, adversarial review, task, the background job lifecycle, the tool counter, and transfer against real credentials | spends tokens |

`npm test` is the suite to run on every change. The live suite is opt-in and
runs one file at a time. `OPENCODE_LIVE_MODEL` sets the model for it;
`OPENCODE_LIVE_TOOL_MODEL` overrides just the tool-counter test, for when the
default model does not call tools reliably.

## Known limits

- Developed and used on macOS. The hermetic suite runs on Linux in CI, but the
  plugin has not been exercised end to end against a real opencode server there.
- If the event stream drops mid-job, the job is not re-fetched from the server,
  so a small window of output can be lost.

## License

MIT — see [LICENSE](LICENSE).
