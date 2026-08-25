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

    .claude/            new, .gitkeep       .claude-plugin/   unchanged
    .github/            expanded            agents/           unchanged
    dist/               new, .gitkeep       commands/         unchanged
    docs/design/        restored            hooks/            unchanged
    examples/           new, .gitkeep       prompts/          unchanged
    reports/            new, .gitkeep       schemas/          unchanged
    src/                was scripts/        skills/           unchanged
    tests/              unchanged           tools/            new, .gitkeep

Git cannot track an empty directory, so each directory with no content yet
gets a `.gitkeep`. These are `.claude/`, `dist/`, `examples/`, `reports/`,
and `tools/`.

## Renaming scripts/ to src/

The template calls the code directory `src/`; this repository calls it
`scripts/`. The rename touches 132 references.

It is mechanically safe. No file inside `scripts/` refers to that directory
by name, because every internal import is relative (`./lib/state.mjs` and
similar). The only bare word `scripts` anywhere else in the repository is
the `"scripts":` key in `package.json`, which carries no trailing slash and
so cannot match a replacement anchored on `scripts/`.

Three reference shapes need rewriting:

- Relative imports `../scripts/` and `../../scripts/` in 35 files under
  `tests/`, including `tests/helpers/` and `tests/live/`.
- `${CLAUDE_PLUGIN_ROOT}/scripts/` in `hooks/hooks.json` (3 occurrences),
  in eight files under `commands/` (22 occurrences), and in
  `skills/opencode-server-runtime/SKILL.md` (1 occurrence).
- Nothing in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
  or `package.json`, none of which mention the directory.

The move is performed with `git mv scripts src` so history follows the
files, and the reference rewrite lands in the same commit, because the
repository does not work in any state between the two.

Two tests are load-bearing for this change and are expected to pass without
being edited beyond their import paths. `tests/lint-commands.test.mjs`
checks that every command file invokes a verb the companion actually
exports, which catches a command left pointing at a stale path.
`tests/unit/manifests.test.mjs` checks the plugin and marketplace manifests.

A compatibility shim at the old path was considered and rejected. The
plugin is loaded by path from `${CLAUDE_PLUGIN_ROOT}`, and `package.json`
is private with no published entry points, so there is no consumer outside
this repository that could hold a reference to `scripts/`.

## Documentation

`docs/design/` held two design specs until the v1.0.1 release commit
`e5a83ae` deleted them, one commit after `3c9e1e4` had deliberately kept
them and moved them to that path. The deletion appears accidental. Both
files are restored from `3c9e1e4`:

- `2026-08-02-opencode-plugin-cc-design.md`
- `2026-08-05-live-coverage-widening-design.md`

This document joins them.

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

`.github/workflows/ci.yml` already exists and is not modified.

## Out of scope

The version is not bumped; this changes no behaviour. `.gitignore` is
correct as it stands and is not touched. `.superpowers/` is gitignored
working scratch and does not move. No behavioural change is made to any
file under `src/` beyond its new location.

## Verification

- `npm test` is the gate. It runs the unit suite, the integration suite,
  and the command lint, and is the same suite CI runs on Linux and macOS.
- `grep -rn 'scripts/' --exclude-dir=.git --exclude-dir=.superpowers .`
  must return nothing outside `docs/`, whose prose names the old path, once the
  rename is complete.
- `node -e` import smoke of `src/opencode-companion.mjs` confirms the entry
  point resolves at its new path.
- `npm run test:isolated` needs a real opencode binary on PATH. It runs if
  one is present, and its absence is reported rather than passed over.
- `npm run test:live` needs real credentials and spends tokens. It is not
  run as part of this change.
