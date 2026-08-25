---
name: opencode-server-runtime
description: Use when an opencode job hangs, the broker will not start, a port is stuck, or job state looks wrong.
---

The plugin uses a small broker around `opencode serve`. It spawns one broker per
shared endpoint using the lockfile `lock` and records the endpoint in the
portfile `port.json` under
`${XDG_STATE_HOME:-$HOME/.local/state}/opencode-plugin-cc/broker/`.
References are tracked for Claude Code sessions and job workers. The broker is
shut down when the last live reference releases it.

When the broker will not start, a port is stuck, or state is inconsistent, run
`node "${CLAUDE_PLUGIN_ROOT}/src/opencode-companion.mjs" repair`. Repair
reaps an orphaned broker endpoint and its stale ownership/reference state, marks
running jobs whose execution owners are gone as stale, and removes expired
terminal job records. It does not clear a live broker just because repair was
requested.

Review and task jobs consume an SSE event stream. If a stream drops, the job
reconnects with backoff while the job continues server-side; the worker persists
events and the result on disk rather than treating a dropped client stream as
the end of the job.

Job records are namespaced by Claude Code session ID. A different Claude Code
window cannot see this session's jobs by design, so use the session that started
the job when running `status`, `result`, or `cancel`.
