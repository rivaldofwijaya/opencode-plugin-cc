---
description: Challenge the current change's design decisions, premises, and assumptions with opencode.
argument-hint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus]"
allowed-tools: Bash, AskUserQuestion
---

Delegate an adversarial code review of the current change to opencode. This
review challenges the change's design decisions, premises, and assumptions, not
only its defects. You do not review the code yourself and you do not fix
anything.

Arguments: $ARGUMENTS

This differs from `review` by prompt and focus text only: it uses the same
pipeline and produces the same output shape. Any free-form focus text is passed
after `--` so it is treated as focus text rather than another flag.

**1. Size the change first.**

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review-size --json` with any `--base` or `--scope` the user gave.

The JSON tells you `scope`, `empty`, `tiny`, `files`, and `untracked`. Untracked
files and directories are reviewable work. Conclude there is nothing to review
only when `empty` is `true`; when in doubt, run the adversarial review.

If `review-size` cannot produce its JSON, stop and surface the companion's
failure. Exit code `1` is a reported gap, `2` is an invalid invocation, and `3`
is an unexpected crash.

**2. Decide wait vs background.**

- If the user passed `--wait` or `--background`, obey it without asking.
- Otherwise, if `tiny` is `true`, recommend *wait*.
- In every other case — including unclear size — recommend *background*.

Ask once with `AskUserQuestion`, with the recommended option first and labelled
`(Recommended)`. Do not ask twice and do not ask when the flag was given.

**3. Run it.**

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" adversarial-review --wait` (or `--background`),
passing through any `--base`, `--scope`, `--model`, and `--variant` the user gave,
then pass any free-form focus text after `--`.

**4. Return the output verbatim.**

Print the companion's stdout exactly as it came back. Do not summarize it, do not
re-rank the findings, do not add your own commentary, and do not act on the
findings unless the user asks you to. If the companion exits with code `1`, keep
any stdout and surface any stderr unchanged; do not treat that reported gap as a
reason to rewrite the output. Codes `2` and `3` mean invalid invocation and
unexpected crash respectively.
