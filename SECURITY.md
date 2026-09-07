# Security Policy

## Supported Versions

Only the latest released minor version of the Elide VS Code extension (as published to the
Visual Studio Marketplace) receives security fixes. Please update to the latest release before
reporting an issue.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report vulnerabilities using GitHub's private vulnerability reporting feature for this
repository:

<https://github.com/elide-dev/vscode/security/advisories/new>

If you are unable to use GitHub's private reporting flow, email engineering@elide.dev as a fallback.

We will acknowledge and triage reports on a best-effort basis. There is no guaranteed response
time, but we aim to respond as quickly as we reasonably can.

## Scope

This policy covers the code in this repository: the VS Code extension (`packages/vscode`) and the
`@elide/ide-core` library (`packages/core`) it depends on.

The Elide CLI itself is a separate project and is out of scope here; report CLI vulnerabilities
against <https://github.com/elide-dev/elide>.
