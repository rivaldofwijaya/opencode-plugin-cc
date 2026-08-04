---
description: Check and configure opencode for this plugin — binary, credentials, model, and server.
argument-hint: "[--gate on|off] [--status] [--repair]"
allowed-tools: Bash, AskUserQuestion
---

Arguments: $ARGUMENTS

If the user passed `--gate on|off`, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" gate --on` or
`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" gate --off`, print
stdout verbatim, and stop. If they passed `--status`, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" doctor`, print
stdout verbatim, and stop. If they passed `--repair`, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" repair`, print
stdout verbatim, and stop.

The underlying gate status form is also available when needed:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" gate --status` prints
the bare value `on` or `off`, with no sentence around it.

Otherwise run the full onboarding:

**1. Diagnose.** Run:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" doctor --json`

Read the JSON report. If `ok` is true, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" doctor`, print that
stdout verbatim, and stop — everything is already configured.

**2. Binary gap.** If `binary.ok` is false, tell the user how to install opencode
for their platform and stop. Do not attempt the install yourself.

**3. Auth gap.** If `auth.ok` is false, ask with `AskUserQuestion` which provider
to configure. Present already-reachable options first, in this order: a provider
already listed in `auth.providers`; a provider named in `auth.envHints` (its key
is already in the environment); a local Ollama if `http://127.0.0.1:11434`
answers.

For an API-key provider, print the provider's key page URL, note that credentials
live in `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json`, and give the
user this exact command to run themselves with a `!` prefix so the output lands
in the conversation:

`!node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" set-key --provider <provider> --key <API_KEY>`

Never ask the user to paste the key to you, never read `auth.json`, and never
echo a key. For OAuth or device-code providers, tell them to run
`opencode auth login` interactively instead.

**4. Model gap.** If `model.ok` is false, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" models --provider <provider>` and ask with
`AskUserQuestion` which model to use, populating the options from that real list.
Then run:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" set-model --model <provider/model> --scope global`

Use `--scope project` instead only if the user asked for a repo-local setting.

**5. Verify.** `set-key` and `set-model` re-run doctor themselves. Print their
stdout verbatim. Never assert that setup succeeded on the basis of a write you
have not seen verified by a fresh doctor report.

For these companion calls, exit code `1` is a reported gap, `2` is an invalid
invocation, and `3` is an unexpected crash. Preserve companion stdout verbatim
and surface stderr unchanged. The `doctor --json` gap case is the exception
specified by the companion: it writes only the JSON report to stdout, with no
stderr, so read that report before reacting.
