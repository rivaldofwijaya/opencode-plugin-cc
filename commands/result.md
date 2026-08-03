---
description: Read the result of an opencode job.
argument-hint: "<jobId>"
allowed-tools: Bash, AskUserQuestion
---

Arguments: $ARGUMENTS

If the user gave no job id, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status` first, print
that companion stdout verbatim, and ask with `AskUserQuestion` which job to read.

Once a job id is available, run:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" result <jobId>`

Print the companion's stdout verbatim. Do not poll or recreate the job. Exit code
`1` is a reported gap, `2` is an invalid invocation, and `3` is an unexpected
crash; preserve any stdout and surface stderr unchanged.
