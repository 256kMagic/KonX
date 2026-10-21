# Updating KonX

This guide covers the updater in KonX 0.6.1 for Windows x64. The updater was introduced in the local 0.6.0 test build; 0.6.1 is its first public release and carries the same update features. Versions 0.5.0 and earlier need one manual installation or portable-file replacement to gain the button.

- **From 0.5.0 or earlier:** save your work, close KonX, and install 0.6.1 or replace your portable executable manually.
- **From the local 0.6.0 installed or portable build:** choose **Update KonX** to reach 0.6.1 once its complete stable release is published. An unpacked development build does not support in-place updates.
- **From 0.6.1 onward:** use the same button for newer stable releases. If no newer release exists, KonX reports that it is up to date.

## One-press update

Save local and remote documents and Knowledge notes. Disconnect terminal and SFTP sessions, finish transfers, and stop captures or tool jobs. Then choose **Update KonX** on Home or **Settings → Updates**.

KonX checks the latest published stable release in `256kMagic/KonX`, selects the file for your distribution, downloads it, and verifies its size and SHA-256 checksum. With no work active, it updates and restarts automatically. Progress is visible and a download can be cancelled. If work still needs attention, the verified update stays ready: finish the listed steps and choose **Install and restart**.

The updater does not need a GitHub account or key. It does not check on startup, install when you ordinarily quit, install prereleases, or downgrade to an older public release. Source checkouts and unpacked builds explain why in-place updating is unavailable.

## Installed and portable copies

An installed copy uses the KonX installer in update mode, preserving the current folder and per-user/all-users installation. Updating an all-users installation can require a Windows administrator prompt. Cancelling that prompt leaves the update unapplied.

A portable copy replaces the same executable, even if you renamed it, and restarts from that location. Its containing folder must be writable. The old file is retained as a backup during replacement so a failed swap or restart can recover it. A portable update does not install KonX or move the Windows profile.

Settings, saved sessions, encrypted credentials, and the local knowledge library stay in the existing profile. Capture buffers and terminal sessions are not restored after restart; save any evidence you need before updating.

## If an update fails

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
