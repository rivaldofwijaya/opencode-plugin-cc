---
description: Export this conversation into a new opencode session (one-way).
allowed-tools: Bash
---

This command is a one-way export of this conversation into a new opencode
session. It performs no redaction of conversation content: sensitive transcript
text may be sent to opencode. Work done in opencode does not come back to this
session.

Run:

`node "${CLAUDE_PLUGIN_ROOT}/src/opencode-companion.mjs" transfer`

Print the companion's stdout verbatim. If it exits with code `1`, treat that as a
reported gap and surface any stderr unchanged; code `2` is an invalid invocation
and code `3` is an unexpected crash. Do not claim the export succeeded beyond
what the companion reports.
