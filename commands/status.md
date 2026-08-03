---
description: Show opencode jobs for this Claude Code session.
allowed-tools: Bash
---

Run:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status`

Print the companion's stdout verbatim and add nothing. Exit code `1` is a
reported gap, `2` is an invalid invocation, and `3` is an unexpected crash.
