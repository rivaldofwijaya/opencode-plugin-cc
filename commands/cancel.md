---
description: Cancel an opencode job for this Claude Code session.
argument-hint: "<jobId>|--all"
allowed-tools: Bash
---

Arguments: $ARGUMENTS

If the user gave `--all`, run:

`node "${CLAUDE_PLUGIN_ROOT}/src/opencode-companion.mjs" cancel --all`

Otherwise, if the user gave a job id, run:

`node "${CLAUDE_PLUGIN_ROOT}/src/opencode-companion.mjs" cancel <jobId>`

Print the companion's stdout verbatim. If the user gave neither a job id nor
`--all`, let the companion report the invalid invocation. Exit code `1` is a
reported gap, `2` is an invalid invocation, and `3` is an unexpected crash;
surface stderr unchanged.
