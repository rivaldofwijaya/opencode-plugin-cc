# Security policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Report privately through GitHub security advisories:

<https://github.com/rivaldofwijaya/opencode-plugin-cc/security/advisories/new>

Please do not open a public issue for a security report.

If that link returns a 404, private vulnerability reporting has not been
turned on yet. A maintainer enables it under **Settings -> Code security ->
Private vulnerability reporting**.

Expect an acknowledgement within seven days.

## What is in scope

This plugin runs the `opencode` CLI on your behalf, spawns a local broker
process, and keeps job state under your home directory. Reports about how
it spawns processes, handles credentials, or writes state files belong
here.

Vulnerabilities in the `opencode` CLI itself belong to that project, at
<https://github.com/anomalyco/opencode>.
