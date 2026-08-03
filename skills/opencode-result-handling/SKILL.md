---
name: opencode-result-handling
description: Use when presenting opencode review or task output to the user.
---

Companion stdout is returned verbatim — never paraphrased, re-ranked, or
summarized. Preserve the companion's formatting and warnings.

If model output cannot be parsed as review JSON, the renderer includes a note and
the raw output verbatim. That raw output must still be shown in full.

Findings are opencode's opinion, not verdicts. Do not act on them unless the
user asks you to.

For a background job, retrieve its result with `/opencode:result <jobId>`; do not
poll the server or reconstruct the job from the event stream.
