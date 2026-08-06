# opencode plugin for Claude Code

[![CI](https://github.com/rivaldofwijaya/opencode-plugin-cc/actions/workflows/ci.yml/badge.svg)](https://github.com/rivaldofwijaya/opencode-plugin-cc/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A Claude Code plugin that delegates code review and coding tasks to
[opencode](https://opencode.ai).** It adds slash commands like
`/opencode:review` and `/opencode:rescue` so a second AI model — running in its
own process, on a provider you choose — reviews your work or takes over a task,
instead of the same model checking its own output.

If you have been looking for something like
[codex-plugin-cc](https://github.com/openai/codex-plugin-cc) but for opencode
rather than Codex, this is that. codex-plugin-cc is the inspiration for this
project; the two solve the same problem for different backends. This is an
independent project, not affiliated with OpenAI, Anthropic, or the opencode
maintainers.

## Why use it

Asking a model to review its own code is a weak check — it tends to agree with
itself. This plugin gets you a genuinely independent opinion:

- **A different model, a different vendor.** opencode runs whatever you point it
  at — Claude, GPT, Gemini, DeepSeek, Qwen, or a local model through Ollama.
- **Real separation.** opencode runs as its own process with its own context. It
  sees your diff, not your conversation.
- **Non-blocking.** Send a job to the background and keep working; collect the
  result when it lands.

## At a glance

| | |
|---|---|
| **What it is** | A Claude Code plugin wrapping the opencode CLI |
| **What it does** | Second-opinion code review, adversarial review, delegated coding tasks, conversation handoff |
| **Needs** | opencode 1.18.0+, Node.js 22+, one model provider |
| **Cost** | Whatever your chosen model charges. Free models work. |
| **Platform** | Developed on macOS; tests run on Linux and macOS in CI |

## What you get

| Command | What it does |
|---|---|
| `/opencode:review` | A second model reviews your change and reports findings by severity |
| `/opencode:adversarial-review` | Challenges the premises and design of the change, not its syntax |
| `/opencode:rescue` | Hands a coding task to opencode, which runs **with write access** |
| `/opencode:transfer` | Exports the current conversation into a fresh opencode session |
| `/opencode:status` | Lists this session's jobs |
| `/opencode:result` | Prints a finished job's output |
| `/opencode:cancel` | Stops a running job, or all of them |
| `/opencode:setup` | Checks and configures the binary, credentials, model, and server |

## Requirements

- [opencode](https://opencode.ai) 1.18.0 or newer, on your `PATH`
  ([anomalyco/opencode](https://github.com/anomalyco/opencode))
- Node.js 22 or newer
- Credentials for at least one model provider — `/opencode:setup` walks you through it

## Install

```
/plugin marketplace add rivaldofwijaya/opencode-plugin-cc
/plugin install opencode@opencode-plugin-cc
```

Then run setup once and follow what it asks for:

```
/opencode:setup
```

It checks four things — binary, credentials, model, server — and stops at the
first gap with instructions rather than guessing. Re-run it any time; it is also
the repair path. Your API key goes to opencode's own credential store; this
plugin never reads it or asks you to paste it into the chat.

## Commands

### Review your change

```
/opencode:review
/opencode:review --base main
/opencode:review --background
```

Reviews the working tree by default, or a branch diff with `--base`. Findings
come back ordered critical → info. Nothing is fixed — this is review only.

### Argue with your change

```
/opencode:adversarial-review
/opencode:adversarial-review the caching layer
```

Instead of proofreading, this attacks the thinking: wrong abstraction, unstated
assumption, a simpler design you passed over. Add a focus phrase to point it
somewhere specific. Use it when the code is correct but you are unsure it is
*right*.

### Hand off a task

```
/opencode:rescue port the parser to the new API
/opencode:rescue --background migrate the test suite
/opencode:rescue --fresh
```

Gives the task to opencode with write access — useful when Claude Code is stuck
in a loop, or when you want a different model to attempt the work. If you have a
recent opencode thread it asks whether to continue it or start fresh; pass
`--resume` or `--fresh` to skip the question. Output comes back verbatim.

### Move the conversation over

```
/opencode:transfer
```

One-way export of the current conversation into a new opencode session, for when
you want to continue in opencode itself. Work done there does not come back.

> **Note:** transfer performs no redaction. Whatever is in the transcript,
> including anything sensitive, is sent to opencode.

### Manage jobs

```
/opencode:status
/opencode:result job_1a2b3c
/opencode:cancel job_1a2b3c
/opencode:cancel --all
```

Background jobs outlive the command that started them. `status` is scoped to the
current Claude Code session; `cancel` kills the worker process, not just the
record.

## Typical flows

**Review before you commit**

```
/opencode:review --base main
```

**Get unstuck, then collect the result**

```
/opencode:rescue --background rewrite the retry logic
/opencode:status
/opencode:result job_1a2b3c
```

**Pressure-test a design you already like**

```
/opencode:adversarial-review
```

## Automatic review on every turn

```
/opencode:setup --gate on
/opencode:setup --gate off
```

With the gate on, opencode reviews your change whenever Claude Code finishes a
turn, and blocks on critical or high findings. Off by default.

## Choosing a model

`/opencode:setup` writes your choice to opencode's own config, so it is shared
with the opencode CLI rather than duplicated here. Any provider opencode
supports works, including local models via Ollama.

Weak free models are the most common cause of disappointing reviews. They often
return nothing at all, which the plugin reports plainly as "the model returned no
output" rather than pretending to have reviewed something.

## FAQ

### How is this different from codex-plugin-cc?

Same idea, different backend. codex-plugin-cc delegates to OpenAI's Codex; this
delegates to opencode, which is provider-agnostic — so you pick the reviewing
model instead of being tied to one vendor. codex-plugin-cc came first and
inspired this project.

### Do I need a paid API key?

No. Any provider opencode supports works, including free-tier models on
OpenRouter and fully local models through Ollama. Free models are noticeably
weaker at structured review, though.

### Does it send my whole conversation anywhere?

Only `/opencode:transfer` does, and it says so before it runs. `review`,
`adversarial-review`, and `rescue` send the diff or the task text — not your
Claude Code transcript.

### Can I use it with a local model?

Yes. Point opencode at Ollama during `/opencode:setup` and everything runs on
your machine.

### Does it work on Linux or Windows?

The test suite runs on Linux and macOS in CI. Day-to-day use has only been
exercised on macOS — see [Known limits](#known-limits). Windows is untested.

### Is it the same as running opencode myself?

You could, but you would be copying diffs between two tools by hand. The plugin
handles the diff, job tracking, background execution, cleanup, and getting the
output back into your Claude Code session.

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
