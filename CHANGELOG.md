# Changelog

## Unreleased

### Fixed

- Installed updater detection now checks the physical `app.asar` file rather than Electron's virtual archive directory.
- Installed update handoff reads the installer location and uninstall registration from electron-builder's separate registry keys, validating the application identity, directory, and installation mode together.
- Regression coverage now includes Electron's real ASAR filesystem behavior and the actual installer registry layout. The original 0.6.0/0.6.1 installed update button is affected; portable updating is unaffected. Installed copies need a manual upgrade to a release containing these fixes.

Validation: 485 automated tests pass. Corrected source components completed a real all-users NSIS update from installed 0.6.0 to the published 0.6.1 installer, preserving the installation folder/mode and settings bytes and restarting KonX as 0.6.1. This is a component handoff test; the original installed button failed. See the [release notes](docs/releases/0.6.1.md#validation) for coverage limits.

## 0.6.1 — 2026-10-21

### Added

- First public release of **Update KonX**, carrying the same installed and portable update features introduced in the local 0.6.0 test build.
- A newer version for local 0.6.0 users to exercise **Update KonX** after the complete stable release is published. Version 0.5.0 and earlier still need one manual upgrade to gain the button.
- Current download links, update instructions, and release notes documenting checksum verification, profile preservation, restart guards, and the six inherited review findings that remain unfixed.

This release does not change the updater's application behavior from 0.6.0. Installer and portable copies retain their existing Windows profile. See [0.6.1 release notes](docs/releases/0.6.1.md) and [Updating KonX](docs/UPDATING.md).

Release-time validation: all 482 automated tests passed for 0.6.1. Installer and portable builds completed; all 81 packaged source files matched the release checkout (`41208e0`). Isolated unpacked and portable startup/restart checks passed, including encrypted credential persistence/removal and Knowledge notes. At publication, a complete public-release installation remained an end-to-end test; Windows helper fixtures exercised portable replacement/rollback and installed mode/directory arguments. See the release notes for subsequent live test findings.

## 0.6.0 — unreleased

### Added

- **Update KonX** on Home and in Settings, with one-press release checking, download progress, SHA-256 verification, and installation/restart for Windows x64 installed and portable copies.
- Explicit cancellation, retry, and up-to-date states. Requests use the public KonX GitHub release without a token; startup and ordinary application exit do not trigger updates.
- Restart guards for unsaved documents and Knowledge notes, active connections, transfers, captures, tools, and pending file operations. A verified update can wait while work is saved or stopped.
- Portable replacement preserves the original executable until a verified replacement is ready, retains its location, and supports rollback on replacement/start failure. Installed upgrades preserve the selected installation directory and user/all-users mode.
- `npm run release:prepare` stages release executables, downloadable guides, and the checksum manifest used by the updater.

Version 0.5.0 and earlier require one manual upgrade to gain the button. See [update instructions](docs/UPDATING.md) and [0.6.0 build notes](docs/releases/0.6.0.md).

## 0.5.0 — 2026-10-20

### Added

- Six animated application themes: Arc Reactor, Chroma RGB, Matrix Mainframe, Synthwave Grid, Hologram Prism, and Plasma Forge, with coordinated interface/editor palettes, glow, and output backgrounds.
- Compact top header with **Pause effects**/**Resume effects**, a saved **Animate theme effects** preference, and automatic reduced-motion support. Decorative output backgrounds keep tables, forms, and explanations readable.
- **Follow application theme** terminal palette for coordinated colors and backgrounds, enabled by default for new profiles. Existing profiles retain their selected global and per-session palettes; select the new option in **Settings → Appearance** to opt in. Classic Dark/Light application themes and all existing opaque terminal schemes remain available.

See the [0.5.0 release notes](docs/releases/0.5.0.md) and [Appearance guide](docs/USER_GUIDE.md#appearance-and-motion).

Validation: 439 automated tests pass, including real Electron checks for all six themes, coordinated terminal/editor output, selection, compact toolbar layout, saved motion controls, and Windows reduced motion. All 76 source files match the package; unpacked, portable, and installed application checks pass.

## 0.4.0 — 2026-10-20 (test build)

### Added

- AI & Knowledge workspace with separate Windows-encrypted API keys and editable models for OpenAI, Claude, Gemini, Nyquest, and a custom OpenAI-compatible Chat Completions endpoint.
- Background local SQLite knowledge database with versioned reference articles, overlapping chunks, persistent TF-IDF cosine vectors, local retrieval, and custom note creation, editing, removal, and index rebuilds. Library search and reading work without an AI key.
- Explain with AI actions in tool tabs, bounded result snapshots, explicit redacted-context previews, opt-in sharing, source articles alongside answers, cancellation, and configuration revision guards. No automatic tool execution or collection of saved sessions, documents, or packet payloads.

See the [0.4.0 test-build notes](docs/releases/0.4.0.md), [AI and knowledge guide](docs/AI_KNOWLEDGE_GUIDE.md), and [architecture notes](docs/design/ai-knowledge.md). Older 0.3.0 builds do not include AI.

Validation: 427 automated tests pass, including 43 new AI/provider, offline knowledge, integration, and real Electron workflow checks. All five provider protocols use simulated responses; encryption, SQLite/vector persistence, packaged-ASAR workers, cancellation, scoped sharing, failure states, and responsive layout are exercised without a live AI key or paid generation.

## 0.3.0 — 2026-10-20 (test build)

### Added

- Wi-Fi Tools with native Windows adapter/connection details, cached BSSID survey, signal and channel views, security observations, filtering, and JSON export.
- Mist & Marvis workspace with encrypted API-token storage, regional endpoint selection, authorized organization/site discovery, AP/client snapshots, and direct Marvis device/site troubleshooting.
- Cancellation of active tool jobs during application shutdown, including Wi-Fi inventory children and Mist requests.
- Security Suite tab with local Windows posture checks and a remote Windows TCP-exposure profile.
- TLS/certificate, pre-authentication SSH, web-header, and single-host service-exposure assessments.
- Offline Cisco-style configuration and saved PCAP/PCAPNG security findings with redacted line/frame evidence.
- Result filters, evidence and recommendations, explicit unknown states and scope limits, local opt-in baselines, and JSON/HTML report exports.
- Bounded collection and cancellation when stopped or closed, plus unit, loopback-network, synthetic-file, and real Electron workflow regression coverage.
- Local JavaScript error logs, including startup failures, uncaught main-process errors, and unhandled-rejection warnings. The original Electron error handling remains active; logs rotate at 128 KiB and individual entries are bounded to 16 KiB.

See the [0.3.0 test-build notes](docs/releases/0.3.0.md), [Security Suite guide](docs/SECURITY_SUITE.md), and [Wi-Fi/Mist guide](docs/WIRELESS_MIST_GUIDE.md). These tools are included in 0.3.0; the published 0.2.0 executables and older 0.2.1 test build do not include them.

Validation: 384 automated tests pass, including 36 Wi-Fi/Mist checks, 56 security checks, and 13 diagnostics/boot checks using synthetic inputs, loopback services, and isolated real Electron processes. Wireless coverage includes native WLAN layouts, a nested child loading from an ASAR archive, encrypted token storage, fixed regional HTTPS requests, cancellation, redaction, cloud scope/revision changes, exports, and minimum-window layout. Mist tests use synthetic credentials and mocked cloud responses; no live Mist account was queried. Error-logging tests cover fatal exceptions, warning-only rejections, startup failures, rotation, size limits, and failed log writes. A separate local Windows smoke test completed all 14 posture checks at the current user's permission level; inaccessible firmware/encryption checks remained unknown.

## 0.2.1 — 2026-10-20 (test build)

### Fixed

- Preserve existing local files when SFTP downloads fail or are cancelled; replace them only after a successful download.
- Cancel transfers waiting for conflict decisions or channels, and stop queuing files after the SFTP tab closes.
- Clean up late SFTP logins, failed subsystem setup, transport errors, and external-edit watchers while preserving shared terminal connections.
- Preserve editor changes typed during a reload, confirm before reopening an unsaved document with another encoding, and ignore reads that finish after closure.
- Preserve original files when an atomic editor save cannot replace its destination, and correctly search UTF-16 BE/LE files without counting their BOM as text.
- Reject SSH setup errors without hanging, close jump connections after target failures, and handle log-file errors without terminating the app or stranding a connection.
- Read OpenSSH `key=value` settings and quoted `#` characters, and keep unsupported `Match` blocks from changing the preceding imported host.
- Reject lone `&`/`|` filter operators without freezing the window, validate CIDR/port ranges, and include VLAN zero in the bare VLAN filter.
- Validate pcapng block boundaries, interface references, and packet lengths; exclude simple-packet alignment bytes from captured payloads.
- Keep IP decoding inside its payload boundary and match DNS replies to the correct resolver.
- Deliver network-tool errors/results even when they arrive before the start reply, cancel tools closed during startup, and prevent duplicate starts from clearing active results.
- Start large port scans without allocating the entire host/port task matrix, and preserve completed traceroute summaries.
- Reject empty HTTP Transfer-Encoding fields instead of inventing body boundaries or subsequent requests; retain valid zero-valued TCP handshake timestamps and RTTs.
- Accept case-insensitive SIP version tokens, validate CSeq bounds, and retain correctly framed messages following malformed identities.
- Derive call setup time from its sole answered dialog when SIP tags differ across observed legs.
- Pause Auto-scroll when inspecting Follow Stream packet evidence, surface capture-save errors, and report the actual exported packet count while live capture continues.
- Run Electron layout and SIP view checks at fractional display scales while retaining all viewport and control-bounds assertions.

Validation: 279 automated tests pass on Windows, including 53 regression checks added across the local reviews. The real Electron checks cover connection-tab closure, session dialogs, overflowing tabs, the SIP ladder, SDP, source-packet navigation, and both SIP export actions. The earlier local fixes are integrated with the 0.2.0 stream reconstruction and traffic views.

The Windows x64 installer and portable executable were built with publishing disabled. All 53 packaged source files match the working source. The packaged app passed an isolated SIP workflow check with three calls, SDP, split TCP reconstruction, packet navigation, and JSON/PCAPNG round trips. See the [0.2.1 test-build notes](docs/releases/0.2.1.md).

## 0.2.0 — 2026-10-20

### Added

- TCP stream reconstruction with sequence ordering, retransmission provenance, sequence wrap handling, and explicit gaps and conflicting overlaps. UDP stream views preserve datagram boundaries.
- Readable HTTP/1 request/response pairs across packets, searchable headers and text, formatted JSON, chunked-body decoding, gzip/deflate decoding, and export of complete decoded bodies.
- Text and hex stream views with source-packet links and bounded previews.
- **SIP Calls**: searchable calls across captured UDP/TCP conversations, clickable signaling ladders, observed outcomes and timing, retransmission markers, and separate tagged dialogs for forked calls.
- SDP details for advertised connections, media ports, direction, codec mappings, format parameters, and explicit RTCP attributes.
- Per-call PCAPNG export of original signaling frames and JSON export of messages, SDP, packet references, and analysis warnings.
- Offline reassembly, HTTP, SDP, SIP, export, and navigation regression tests, plus real Electron checks for the SIP workflow and window layout.
- A downloadable synthetic SIP sample and `npm run sample:sip` to regenerate it from a source checkout.

### Fixed

- Session dialogs stay anchored near the top of the window, so changing panels no longer moves their navigation tabs up and down.
- Scrolling upward during live packet capture pauses following and unchecks **Auto-scroll**. Checking it again resumes following; keyboard packet navigation also updates the checkbox.
- Overflowing application tabs remain reachable with scroll arrows, mouse-wheel scrolling, and **Show all tabs**. Selecting a tab reveals it, while background updates preserve manual scrolling.
- Replaced the ambiguous three-dot button-bar control with a dedicated icon, a **Show/Hide button bar** tooltip, and visible toggle state.
- Quick Connect fields now use the same styling as other form controls, and the main toolbar adapts to narrower windows.
- Development builds display the KonX package version rather than the Electron runtime version.
- Fragmented or truncated traffic and conflicting message boundaries remain visibly incomplete instead of becoming apparently complete application content. Delayed traffic and SIP results cannot navigate into a replaced capture or a closed tab.

### Scope

Readable application decoding supports plaintext HTTP/1 over TCP and SIP over UDP/TCP. It does not decrypt TLS, decode HTTP/2, reconstruct RTP audio, or play/decrypt SRTP media. SDP shows captured declarations, not a verified negotiated media path. Missing traffic and analysis limits remain explicit. A call export retains whole original frames; a shared TCP frame may also contain another call's messages.

See the [0.2.0 release notes](docs/releases/0.2.0.md) and [user guide](docs/USER_GUIDE.md) for workflows and limitations.

## 0.1.2

- Fixed the connection-tab close button so clicking it removes the tab and disconnects its session.
- Included the earlier SFTP download-path, connection-error and trust-prompt, editor save-state, remote-edit retry, and live-capture/file-loading fixes.

The 0.1.2 changes are already part of the preceding release; they are retained in 0.2.0.
