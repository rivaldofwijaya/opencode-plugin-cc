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

Otherwise run: `node "${CLAUDE_PLUGIN_ROOT}/src/opencode-companion.mjs" task-resume-candidate --json`

If `hasCandidate` is `true`, ask once with `AskUserQuestion` whether to continue
that opencode thread or start a new one. Order the options by how the task text
reads: put *continue* first when it reads as a follow-up ("continue", "keep
going", "dig deeper", "also"), and *fresh* first when it reads as a new task.

**2. Dispatch to the subagent.**

Use the `Agent` tool with `subagent_type: "opencode-rescue"`. Give it exactly one
instruction: run

`node "${CLAUDE_PLUGIN_ROOT}/src/opencode-companion.mjs" task --wait [--resume|--fresh] [--model <m>] [--variant <v>] -- <task text>`

and return stdout unchanged. Use `--background` instead of `--wait` only if the
user asked for it. Default is foreground. Include `--resume` or `--fresh` only
when the user selected that behavior, and leave model and variant unset unless
the user explicitly asked for them.

**3. Return the output verbatim.**

Print the subagent's output exactly as it came back. Do not summarize, reformat,
or continue the work yourself. The companion's stdout is returned verbatim. If
the task exits with code `1`, treat it as a reported gap; code `2` is an invalid
invocation and code `3` is an unexpected crash. On a non-zero result, preserve
the subagent's stderr unchanged.
