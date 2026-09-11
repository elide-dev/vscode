# Publishing to the Visual Studio Marketplace

Everything in this repository that can be automated is in place: the manifest carries the metadata the Marketplace
requires, `bun run --filter elide package` produces a clean `.vsix`, and `.github/workflows/release.yml` publishes on a
`vX.Y.Z` tag as soon as a `VSCE_PAT` secret exists. What is left are the steps that need a human with an account —
none of them can be done from this repository.

## What the repo already provides

| Requirement                                      | Where                                                                                                                                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publisher`, `name`, `version`, `engines.vscode` | `packages/vscode/package.json` (`elide-dev.elide`, `0.1.0`, `^1.105.0`)                                                                                                             |
| Icon (256×256 PNG, brand mark)                   | `packages/vscode/icon.png`, rasterized from Elide's official `elide-square-gradient` artwork; 128×128 is the Marketplace minimum, 256×256 is what it recommends for retina listings |
| Gallery banner                                   | `galleryBanner` (`#0F0F0F`, dark)                                                                                                                                                   |
| Marketplace README, changelog, license           | `packages/vscode/{README.md,CHANGELOG.md,LICENSE}`, all shipped in the `.vsix`                                                                                                      |
| Repository / issues / homepage links             | `repository`, `bugs`, `homepage` in the manifest                                                                                                                                    |
| Trust and remote declarations                    | `capabilities.untrustedWorkspaces` (unsupported), `capabilities.virtualWorkspaces` (unsupported), `extensionKind: ["workspace"]`                                                    |
| Reproducible package build                       | `vscode:prepublish` builds `@elide/ide-core` and the bundle, so `vsce package` works from a clean checkout                                                                          |
| Automated publication                            | `Release` workflow: tag check → unit tests → `tools/deploy.sh` → `vsce publish --packagePath` (skipped without `VSCE_PAT`) → GitHub release                                         |

The `.vsix` contents were verified locally: `extension/{package.json,README.md,CHANGELOG.md,LICENSE.txt,icon.png,dist/extension.js}`, 40 KB total, no source or test files.

## Remaining manual steps

### 1. Azure DevOps organization and publisher

1. Sign in to <https://dev.azure.com> with the Microsoft/Entra account that should own the extension (a shared Elide
   account, not a personal one — the publisher cannot be transferred without support intervention).
2. Create (or reuse) an Azure DevOps organization for Elide.
3. Create the publisher at <https://marketplace.visualstudio.com/manage/createpublisher>. The **publisher ID must be
   exactly `elide-dev`** — that is what `packages/vscode/package.json` and `tools/deploy.sh` assume. If `elide-dev` is
   already taken, the manifest `publisher`, the extension ID used by `plugins.elide.dev` (`elide-dev.elide`), and the
   README install links all have to change together.
4. Fill in the publisher display name, logo, and links on the management page. This data is publisher-level and cannot
   be set from the manifest.

### 2. Personal access token

1. In Azure DevOps: **User settings ▸ Personal access tokens ▸ New Token**.
2. Organization: **All accessible organizations** (required; a single-org token fails with a 401 at publish time).
3. Scopes: **Custom defined ▸ Marketplace ▸ Manage**. Nothing else.
4. Expiration: maximum is 1 year — put a calendar reminder on the rotation date, or the release workflow starts
   skipping the publish step silently (it only emits a notice when the secret is missing; an expired token fails loudly
   instead).
5. Store it as the repository secret **`VSCE_PAT`** (Settings ▸ Secrets and variables ▸ Actions). No other change is
   needed: the workflow step activates on its own.

### 3. Verify the publisher (optional, recommended)

Domain verification adds the blue check next to the publisher name. It requires adding a TXT record to a domain you
control (`elide.dev`) from the publisher management page. Not required to publish.

### 4. First publication

The very first upload of an extension ID is the risky one — the Marketplace validates the manifest, icon, and README
before the extension appears, and rejected uploads can leave the ID in a half-created state. Two options:

- **Manual first release (recommended).** From a clean checkout:
  ```sh
  bun install
  bun run --filter elide package                 # → packages/vscode/elide-0.1.0.vsix
  cd packages/vscode
  bunx @vscode/vsce login elide-dev              # paste the PAT
  bunx @vscode/vsce publish --no-dependencies --packagePath elide-0.1.0.vsix
  ```
  Then tag `v0.1.0` so the plugins.elide.dev upload and GitHub release happen through the workflow (the workflow's
  Marketplace step will re-publish the same version and fail if `VSCE_PAT` is already set — publish manually *or* by
  tag for the first release, not both).
- **Tag-driven.** Set `VSCE_PAT` first, then push `v0.1.0` and watch the `Release` run.

Marketplace validation runs asynchronously after upload; the listing goes live within a few minutes, and a validation
failure arrives by email to the publisher account.

### 5. Post-publication follow-ups

- Add the Marketplace badges to the READMEs once the listing exists, e.g.
  `https://img.shields.io/visual-studio-marketplace/v/elide-dev.elide` (version) and `.../i/elide-dev.elide`
  (installs). `img.shields.io` is on vsce's trusted-badge list, so these are safe in the packaged README.
- Replace the "Until the extension is on the Marketplace…" section of the root `README.md` with the Marketplace
  install instructions (`code --install-extension elide-dev.elide`), keeping the `plugins.elide.dev` link as the
  fallback for air-gapped installs.
- Drop `"preview": true` from `packages/vscode/package.json` when the extension leaves 0.x, so the "Preview" badge
  disappears from the listing.
- Consider publishing to **Open VSX** (<https://open-vsx.org>) as well, for VSCodium, Cursor, Windsurf, and Gitpod
  users: create an Eclipse Foundation account, sign the publisher agreement, mint an access token, and add an
  `npx ovsx publish` step next to the Marketplace step. This needs its own account and agreement, so it is a separate
  manual decision.
- Enable **private vulnerability reporting** in the repository settings (Settings ▸ Code security) so the
  `security/advisories/new` link in `SECURITY.md` resolves; it 404s for reporters until that switch is on.
- Confirm the org identifiers these files assert, none of which can be checked from this repository:
  - `engineering@elide.dev` is the fallback contact in `SECURITY.md` and the enforcement contact in
    `CODE_OF_CONDUCT.md`. It is the address on Elide's release GPG key, so it exists — but confirm it routes to
    people who should receive vulnerability and conduct reports, or swap in a dedicated mailbox.
  - `.github/CODEOWNERS` lists `@sgammon @darvld`, mirroring the main Elide repository's ownership. Switch to a
    GitHub team if one is created; CODEOWNERS silently fails for handles without write access to the repo.

## Things that intentionally were not changed

- `packages/vscode/package.json` keeps `"private": true`. `vsce` ignores the field (it is checked by npm, not by the
  Marketplace); it prevents an accidental `npm publish` of the extension package.
- The extension is not marked as a pre-release (`--pre-release`); `preview: true` is metadata only and does not affect
  the release channel.
- No platform-specific (`--target`) packages: the extension is pure JavaScript and depends on a locally installed
  Elide CLI.
