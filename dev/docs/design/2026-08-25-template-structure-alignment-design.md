# Aligning the repository with the 00-template skeleton

Date: 2026-08-25

## Purpose

Bring `opencode-plugin-cc` into structural parity with the house project
skeleton at `/Volumes/R/projects/2-developing/00-template/`, so this repo
looks like every other project in the collection.

The template is a pure skeleton: every directory in it is empty and every
file is zero bytes. It communicates a layout, not content. Following it
therefore means creating its directories and files here and filling them
with whatever this project's equivalent content is, rather than copying
anything across.

## What the template's layout means

The template draws one line, at the top level, between the product and the
work of building it.

`src/` holds what we built: the code that ships to users. It sits at the
root, alone, because it is the thing the repository is for.

`dev/` holds everything that supports building it, and nothing that ships:

- `dev/tests/` exercises the product
- `dev/scripts/` and `dev/tools/` are development helpers and local tooling
- `dev/reports/` is generated output from that work
- `dev/docs/` is written documentation
- `dev/examples/` is sample usage

The remaining root entries are repository metadata rather than either
category: `.claude/`, `.github/`, `LICENSE`, `README.md`, `SECURITY.md`,
and `.gitignore`.

There is no `dist/`. Nothing here is built; the plugin ships its source and
Claude Code runs the `.mjs` files under `src/` directly.

That split is what decides where this repository's existing code goes.

## Constraints

Claude Code resolves a plugin's `commands/`, `agents/`, `skills/`, and
`hooks/hooks.json` from paths declared in `.claude-plugin/plugin.json`, and
`.claude-plugin/marketplace.json` points at the repository root as the
plugin source. Those four directories plus `.claude-plugin/` are the
plugin's public interface, not source code, so they stay at the top level.
`prompts/` and `schemas/` are data the runtime loads by path and stay with
them. The template names none of these directories, so keeping them is
additive rather than a deviation from it.

The project has zero runtime and development dependencies, and a test
asserts that. Anything added here must not introduce one.

## Target layout

    src/                  was scripts/         .claude-plugin/  unchanged
    dev/docs/design/      was docs/design/     agents/          unchanged
    dev/examples/         new, .gitkeep        commands/        unchanged
    dev/reports/          new, .gitkeep        hooks/           unchanged
    dev/scripts/          new, .gitkeep        prompts/         unchanged
    dev/tests/            was tests/           schemas/         unchanged
    dev/tools/            new, .gitkeep        skills/          unchanged
    .claude/              new, .gitkeep
    .github/              expanded
    LICENSE, README.md, SECURITY.md, .gitignore   at the root

Git cannot track an empty directory, so each directory with no content yet
gets a `.gitkeep`: `.claude/`, `dev/examples/`, `dev/reports/`,
`dev/scripts/`, and `dev/tools/`.

## Moving the shipped code into src/

Everything currently under `scripts/` is shipped product, so all of it
moves to `src/`:

- `opencode-companion.mjs`, `session-lifecycle-hook.mjs`, and
  `stop-review-gate-hook.mjs` are invoked by name from `hooks/hooks.json`,
  the files under `commands/`, and one skill.
- `server-broker.mjs` is spawned at runtime by `lib/broker-lifecycle.mjs`.
  That reference is a relative URL, so it survives the move untouched.
- Everything under `lib/` is imported by the above.

Nothing there is a development helper, so `dev/scripts/` is created fresh
and empty, ready for helpers that do not exist yet. The same goes for
`dev/tools/` and `dev/reports/`.

The move is mechanically safe. No file inside `scripts/` refers to that
directory by name, because every internal import is relative
(`./lib/state.mjs` and similar). The only bare word `scripts` anywhere else
in the repository is the `"scripts":` key in `package.json`, which carries
no trailing slash and so cannot match a replacement anchored on `scripts/`.

## Moving the tests into dev/tests/

`tests/` moves wholesale to `dev/tests/`, keeping its internal structure
(`unit/`, `integration/`, `isolated/`, `live/`, `helpers/`, `captures/`,
`fixture-bin/`) unchanged.

Nothing inside `tests/` refers to itself by a non-relative path, and the
capture files and the fixture binary are reached relatively from the tests
that use them, so the move breaks nothing internal. The only outside
references are the three globs in `package.json`, which gain a `dev/`
prefix.

Because the suite drops one level deeper while `src/` stays at the root,
every test import of the shipped code gains one `../`.

## The reference rewrite

Four rules, applied in this order so that no rule can rewrite text a later
rule depends on:

1. `../../scripts/` becomes `../../../src/` — test files one directory deep
   under `tests/`, which is all of `unit/`, `integration/`, `isolated/`,
   `live/`, and `helpers/`.
2. `../scripts/` becomes `../../src/` — `tests/lint-commands.test.mjs`,
   which sits directly under `tests/`.
3. `${CLAUDE_PLUGIN_ROOT}/scripts/` becomes `${CLAUDE_PLUGIN_ROOT}/src/` —
   `hooks/hooks.json` (3 occurrences), eight files under `commands/` (22
   occurrences), and `skills/opencode-server-runtime/SKILL.md` (1).
4. The three `tests/` globs in `package.json` gain a `dev/` prefix.

Rules 1 and 2 must run in that order. `../scripts/` is a substring of
`../../scripts/`, so applying rule 2 first would corrupt the deeper paths.

Together rules 1 to 3 cover all 132 occurrences of `scripts/`. Nothing in
`.claude-plugin/plugin.json` or `.claude-plugin/marketplace.json` needs
changing; neither mentions either directory.

Both moves use `git mv` so history follows the files, and the whole rewrite
lands in a single commit, because the repository does not work in any state
between the moves. The `.gitkeep` files are created afterwards, so git sees
clean renames rather than renames tangled with new files at the old paths.

Two tests are load-bearing here and are expected to pass without being
edited beyond their import paths. `tests/lint-commands.test.mjs` checks
that every command file invokes a verb the companion actually exports,
which catches a command left pointing at a stale path.
`tests/unit/manifests.test.mjs` checks the plugin and marketplace
manifests.

A compatibility shim at either old path was considered and rejected. The
plugin is loaded by path from `${CLAUDE_PLUGIN_ROOT}`, and `package.json`
is private with no published entry points, so no consumer outside this
repository can hold a reference to `scripts/`.

## Documentation

`docs/design/` held two design specs until the v1.0.1 release commit
`e5a83ae` deleted them, one commit after `3c9e1e4` had deliberately kept
them and moved them to that path. The deletion appears accidental. Both are
restored, at the template's location for documentation:

- `dev/docs/design/2026-08-02-opencode-plugin-cc-design.md`
- `dev/docs/design/2026-08-05-live-coverage-widening-design.md`

This document sits beside them.

## GitHub metadata

The template carries a set of community and automation files that this
repository does not have. Because the repository is public, each is written
with real content rather than left at zero bytes.

- `SECURITY.md` directs vulnerability reports to GitHub private security
  advisories on this repository, naming no email address. Private
  vulnerability reporting must be enabled once in the repository settings
  for that link to work; the document says so.
- `.github/CODEOWNERS` assigns everything to `@rivaldofwijaya`.
- `.github/dependabot.yml` covers the `github-actions` ecosystem only. The
  project has no npm dependencies, so an `npm` entry would find nothing.
- `.github/ISSUE_TEMPLATE/bug.yml`, `feature.yml`, and `config.yml`.
- `.github/PULL_REQUEST_TEMPLATE.md`.
- `.github/workflows/security.yml` runs CodeQL for JavaScript.
- `.github/workflows/dependency-review.yml` runs on pull requests.
- `.github/workflows/release.yml` creates a GitHub release from a pushed
  `v*` tag.

`.github/workflows/ci.yml` already exists and is not modified. It invokes
`npm test`, so the relocated suite reaches it through `package.json`
without the workflow changing. Its explanatory comment names the
`test:isolated` and `test:live` scripts by name, not by path, so it stays
accurate.

## Out of scope

The version is not bumped; this changes no behaviour. `.gitignore` is
correct as it stands and is not touched. `.superpowers/` is gitignored
working scratch and stays where it is. No behavioural change is made to any
moved file beyond its new location.

## Verification

- `npm test` is the gate. It runs the unit suite, the integration suite,
  and the command lint, and is the same suite CI runs on Linux and macOS.
- `grep -rn 'scripts/' --exclude-dir=.git --exclude-dir=.superpowers .`
  must return nothing outside `dev/docs/`, whose prose names the old path.
- The same grep for `'tests/'` must return only `dev/tests/` hits and the
  same documentation.
- `node -e` import smoke of `src/opencode-companion.mjs` confirms the entry
  point resolves at its new path.
- `npm run test:isolated` needs a real opencode binary on PATH. It runs if
  one is present, and its absence is reported rather than passed over.
- `npm run test:live` needs real credentials and spends tokens. It is not
  run as part of this change.
