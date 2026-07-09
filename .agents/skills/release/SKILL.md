---
name: release
description: Publish a new Armada release with versioning, changelog, and git tagging. Triggered by "publish a new release", "cut a release", "tag a release", or similar requests.
---

# Release Skill (Armada)

This skill guides you through publishing a new release of Armada. Pushing a
version tag (`vX.Y.Z`) triggers the GitLab CI pipeline, which builds the signed
Android APK/AAB and the desktop installers (Linux + Windows; macOS is manual),
uploads them to the generic package registry, and creates a GitLab Release with
download links.

## Overview

- **Version format**: Marketing version `X.Y.Z`. **This is NOT strict semver.**
  The number reflects how significant the update looks to an end user, like an
  app-store version — not API compatibility.
- **Version source of truth**: the **git tag** (`vX.Y.Z`). Unlike many projects,
  Armada does **not** keep the version in `package.json` or `build.gradle`. CI
  derives it from the tag and stamps it into the Android build at build time:
  - `VERSION_NAME` ← the tag minus the leading `v` (`v0.2.0` → `0.2.0`)
  - `VERSION_CODE` ← `CI_PIPELINE_IID`
  - The Electron `package.json` `version` is likewise stamped from the tag.
  So you never hand-edit a version field; you just choose the tag.
- **Changelog**: `CHANGELOG.md` in the repo root, [Keep a Changelog](https://keepachangelog.com/)
  format. (Created on first release if absent.) It feeds the GitLab Release
  description.
- **Version bumping**:
  - **Patch (Z)**: Most releases. Bug fixes, tweaks, internal improvements, CI
    changes — anything a user wouldn't specifically seek out.
  - **Minor (Y)**: Headline features worth announcing.
  - **Major (X)**: Only when the user explicitly requests it (milestones,
    rebrands, major redesigns).
- **CI trigger**: a tag matching `/^v\d+\.\d+\.\d+$/`.

## Release Procedure

Follow these steps in order. Do NOT skip any step.

### Step 1: Pre-flight Checks

```bash
git fetch --tags origin    # CRITICAL: sync remote tags before anything else
git status                 # working tree should be clean (or commit/abort)
git branch --show-current  # should be main
npm run test               # full client suite: tsc + eslint + vitest + build
```

- **Always `git fetch --tags origin` first.** The version is carried by the git
  tag, and tags may exist on the remote that you don't have locally (e.g. a
  previous release tagged from another machine). Skipping this makes
  `git log <last-tag>..HEAD` report the wrong "latest tag", so you can
  misidentify the last released version, duplicate already-shipped changelog
  entries, or pick a version that's already taken. Fetch tags before Step 2.
- If the working directory has uncommitted changes, ask the user whether to
  commit them first or abort.
- If not on `main`, warn and ask whether to proceed.
- If tests or builds fail, stop and fix before continuing. The release must not
  contain broken code. (AGENTS.md: verify the client `npm run test` passes
  before committing.)

### Step 2: Determine What Changed

Make sure you ran `git fetch --tags origin` in Step 1 first, so the local tag
list reflects the remote.

```bash
# Latest release tag (empty if this is the first release)
git tag -l 'v*' | sort -V | tail -1

# Commits since that tag (or all history if none)
git log <last-tag>..HEAD --oneline
```

- If there are no commits since the last tag, inform the user there is nothing
  to release and stop.

### Step 3: Decide the Version Bump

| Bump | When to use | Example |
|------|-------------|---------|
| **Patch** | Bug fixes, minor tweaks, dependency updates, small UI polish, CI/build changes, infra | 0.2.0 → 0.2.1 |
| **Minor** | Significant new user-facing features you'd announce (e.g. voice, push notifications, a new surface) | 0.2.1 → 0.3.0 |
| **Major** | ONLY when the user explicitly instructs it | 0.3.0 → 1.0.0 |

**Default to patch** when in doubt: "Would a regular user notice and care?" If
no, it's a patch. Reset lower components on a bump (minor → patch 0; major →
minor and patch 0).

The very first tagged release is whatever the user asks for (e.g. `v0.1.0`).

### Step 4: Write the Changelog Entry

Prepend a new section to `CHANGELOG.md` directly below the `# Changelog`
heading (create the file with a `# Changelog` heading if it does not exist).

```markdown
## [X.Y.Z] - YYYY-MM-DD

A short single-paragraph plain-prose summary of this release (≤ ~500 chars).
This is the headline for the GitLab Release.

### Added
- New features

### Changed
- Changes to existing features

### Fixed
- Bug fixes

### Removed
- Removed features
```

#### Changelog quality rules

- **Diff the code, not just the commit log.** `git diff <prev>..HEAD` reveals
  intra-release churn (bugs introduced then fixed, reverted features) that
  commit messages hide.
- **Only ship what the user sees.** If a bug was introduced AND fixed within
  this release, the user never saw it — omit it. Same for features added then
  reverted. Apply the test: "Did a user on the previous published version
  experience this exact thing?"
- **Collapse related work into one entry.** Present the finished result, not the
  development history. Never list a feature as "Added" and then also list fixes
  for that same feature.
- Write **user-facing descriptions**, not raw commit messages. One line each.
- Use present tense ("Add push notifications", not "Added").
- Only include categories that have entries.
- **No Nostr jargon.** Don't put NIP numbers or kind numbers in the changelog
  (e.g. write "push notifications for messages", not "Web Push for kind-9
  events"). The audience is end users.
- **Omit purely internal changes** (CI tweaks, build pipeline, dev tooling)
  unless they have a direct, visible user impact.

### Step 5: Commit the Changelog

The version is carried by the tag, so the only file to commit is the changelog
(plus any release-prep changes the user asked for).

```bash
git add CHANGELOG.md
git commit -m "Release vX.Y.Z"
```

Commit message style: concise, imperative, sentence case (matches `git log`).

### Step 6: Pull Latest Changes

```bash
git pull origin main
```

**CRITICAL**: Always use `git pull` (merge), NEVER `git pull --rebase`. Rebasing
rewrites commit hashes and would orphan a tag pointing at the original commit.
Resolve any conflicts before proceeding.

### Step 7: Tag the Release

```bash
git tag vX.Y.Z
```

Tag format is `v` + the version, no suffix (e.g. `v0.2.0`, `v0.2.1`).

### Step 8: Push

```bash
git push origin main vX.Y.Z
```

**CRITICAL**: Push only the specific tag being released. NEVER use `--tags` —
that pushes ALL local tags, including stale or deleted ones.

This triggers the GitLab CI pipeline (see below).

### Step 9: Confirm

After pushing, tell the user:
- The new version number
- A brief summary of what was released
- That CI will build and publish the artifacts, and where to find them (GitLab
  Release page + the project's Packages registry)
- That the **macOS** desktop build is a manual job and only runs if a
  `macos`-tagged runner is available (see the `mac-runner` skill if one exists)

## CI Pipeline

`.gitlab-ci.yml` runs on tags matching `/^v\d+\.\d+\.\d+$/`:

1. **build-apk** — signed Android APK + AAB (`eclipse-temurin:21-jdk` + Android
   SDK). Decodes the JKS keystore from `ANDROID_KEYSTORE_BASE64`, migrates it to
   PKCS12, builds web assets, `cap sync android`, then `assembleRelease
   bundleRelease`. Uploads to the generic package registry.
2. **build-desktop-linux** — Electron AppImage + deb (`electronuserland/builder`).
3. **build-desktop-windows** — Electron NSIS installer + portable `.exe`
   (`electronuserland/builder:wine`, cross-built from Linux).
4. **build-desktop-macos** — Electron `.dmg`. **Manual + `allow_failure`**;
   needs a runner tagged `macos`. Unsigned unless Apple signing secrets are set.
5. **release** — creates the GitLab Release with download links for the APK,
   AAB, and the Linux/Windows desktop installers.

### Required CI/CD variables (Android signing)

Set in GitLab → Settings → CI/CD → Variables (Masked; Protected if tags are
protected). Generate with `keytool` (alias `upload`, JKS); see the project
secrets notes.

| Variable | What |
|----------|------|
| `ANDROID_KEYSTORE_BASE64` | base64 of the JKS upload keystore (single line) |
| `KEYSTORE_PASSWORD` | keystore store password |
| `KEY_PASSWORD` | key password (**must equal** the store password — CI migrates JKS→PKCS12, which uses one password) |

Optional:

| Variable | What |
|----------|------|
| `ARMADA_APP_URL` | Origin the desktop shell loads (defaults to the public deploy). |
| `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS code signing / notarization (only for a Gatekeeper-friendly `.dmg`). |

Never commit the keystore, passwords, or any secret material. `.gitignore`
already excludes `*.jks`, `*.keystore`, and `key.properties`.

## Troubleshooting

### "Nothing to release"
If `git log <last-tag>..HEAD` shows no commits, there is genuinely nothing to
release.

### Tests or builds fail
Fix them before proceeding; the release must not contain broken code.

### Wrong version tagged (not yet pushed)
```bash
git tag -d vX.Y.Z          # delete the local tag
git reset --soft HEAD~1    # undo the release commit, keep changes staged
```
Then redo steps 3–7 with the correct version.

### Already pushed a bad release
Requires manual intervention. Tell the user; they may need to delete the tag and
Release in GitLab, then re-run. Note version tags are often **protected** and
can't be force-updated — avoid this by getting the version right before pushing.
```
