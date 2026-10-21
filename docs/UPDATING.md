# Updating KonX

**Installed 0.6.0 and 0.6.1 need one manual upgrade to 0.7.0.** Their update button misidentifies the installed app and reads the installation location from the wrong registry key. The fixes introduced in 0.6.2 are retained in 0.7.0. Installed 0.6.2 and portable 0.6.0 or later copies can use **Update KonX** to obtain 0.7.0.

This guide covers KonX 0.7.0 for Windows x64. **Update KonX** checks for newer stable releases, downloads the correct file, verifies it, and restarts when work is safe. It is available for installed copies from 0.6.2 and portable copies from 0.6.0.

| Current copy | Upgrade to 0.7.0 |
| --- | --- |
| Installed 0.6.0 or 0.6.1 | Save work, close KonX, and run `KonX-Setup-0.7.0.exe` manually using the existing installation folder and per-user/all-users mode. |
| Installed 0.6.2 through 0.6.3 | Choose **Update KonX** and finish any work listed before restart. Approve Windows elevation if requested for an all-users installation. |
| Portable 0.6.0 through 0.6.3 | Choose **Update KonX**, or replace the portable executable manually after closing KonX. |
| Version 0.5.0 or earlier | Save work, close KonX, and run the 0.7.0 installer or replace the portable executable manually. |
| Installed or portable 0.7.0 | Use **Update KonX** for future stable releases. If no newer release exists, KonX reports that it is up to date. |

Download [KonX-Setup-0.7.0.exe](https://github.com/256kMagic/KonX/releases/download/v0.7.0/KonX-Setup-0.7.0.exe), [KonX-0.7.0-portable.exe](https://github.com/256kMagic/KonX/releases/download/v0.7.0/KonX-0.7.0-portable.exe), and [SHA256SUMS.txt](https://github.com/256kMagic/KonX/releases/download/v0.7.0/SHA256SUMS.txt) from the same release. Compare the file's SHA-256 hash with the manifest before running a manual download. Do not uninstall the existing copy or delete its profile to upgrade.

## One-press update

These steps apply to installed 0.6.2 or later and portable 0.6.0 or later. Follow the manual upgrade path above for older installed versions.

Save local and remote documents and Knowledge notes. Disconnect terminal and SFTP sessions, finish transfers, and stop captures or tool jobs. Then choose **Update KonX** on Home or **Settings → Updates**.

KonX checks the latest published stable release in `256kMagic/KonX`, selects the file for your distribution, downloads it, and verifies its size and SHA-256 checksum. With no work active, it updates and restarts automatically. Progress is visible and a download can be cancelled. If work still needs attention, the verified update stays ready: finish the listed steps and choose **Install and restart**.

The updater does not need a GitHub account or key. It does not check on startup, install when you ordinarily quit, install prereleases, or downgrade to an older public release. Source checkouts and unpacked builds explain why in-place updating is unavailable.

## Installed and portable copies

An installed copy uses the KonX installer in update mode, preserving the current folder and per-user/all-users installation. Updating an all-users installation can require a Windows administrator prompt. Cancelling that prompt leaves the update unapplied.

A portable copy replaces the same executable, even if you renamed it, and restarts from that location. Its containing folder must be writable. The old file is retained as a backup during replacement so a failed swap or restart can recover it. A portable update does not install KonX or move the Windows profile.

Settings, saved sessions, encrypted credentials, and the local knowledge library stay in the existing profile. Capture buffers and terminal sessions are not restored after restart; save any evidence you need before updating.

## If an update fails

- **Installed 0.6.0/0.6.1 says unsupported or cannot identify its installation:** run the 0.7.0 installer manually once. These older buttons cannot install their own fix.
- **No newer release:** the installed version is at least as new as the published stable release. Nothing is downloaded or replaced.
- **Network or GitHub rate limit:** retry later. No token is required.
- **Missing file or checksum mismatch:** the release cannot be installed through the updater. Retry after the release is corrected; KonX never runs an incomplete or unverified download.
- **Work in progress:** save or stop the work named in the message, then retry installation. KonX does not close your tabs to force an update.
- **Folder permissions or installer refusal:** the updater reports the failure. Use the existing executable or install manually after correcting the permission issue.

Update downloads and handoff diagnostics are stored under the profile's `updates` directory. Error messages identify the handoff status file when one exists. The updater does not modify unrelated applications or drivers.

## Preparing a compatible release

Build with `npm run dist -- --publish never`, then run `npm run release:prepare`. The latter stages the versioned files and checksum manifest in `publication/v<version>/`. It does not upload or publish anything.

Create a stable GitHub release in `256kMagic/KonX` tagged `v<version>`, upload every staged asset while it is a draft, verify the uploads, and publish it as latest. The updater requires these exact files:

- `KonX-Setup-<version>.exe`
- `KonX-<version>-portable.exe`
- `SHA256SUMS.txt`, containing the SHA-256 hashes and exact filenames of both executables

Publish the complete release before exposing it as latest. If a binary is rebuilt, regenerate the manifest. The updater pins downloads to the release's numeric asset IDs and verifies the staged file again before installation. Downloads use HTTPS from GitHub; checksums establish consistency with that release, not an independent code-signing identity. KonX releases remain unsigned unless signing is configured separately.
