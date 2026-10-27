# Changelog

## 0.33.0 — 2026-10-27

- Add visible **Split screen**, **Single view** and **Pop out** workspace shortcuts, reusing open views and the existing divider and native-window behavior.
- Keep live console connections and their work intact while arranging, popping out and docking views.
- Put smaller close controls inside the top-right corner of each Home section panel, with keyboard focus and existing hide/restore behavior retained.

See the [workspace guide](docs/WORKSPACE_LAYOUTS.md#split-screen-shortcut), [user guide](docs/USER_GUIDE.md), and [release notes](docs/releases/0.33.0.md).

## 0.32.0 — 2026-10-27

- Add **Save session** to on-demand terminal and SFTP connections, including the tab menu.
- Prefill connection settings and offer a name, folder and optional encrypted login retention in the existing session editor.
- Save without reconnecting or interrupting active work; subsequent edits target the saved record.
- Preserve existing Home visibility, themes, layouts, sessions and credentials.

See [Session management](docs/SESSION_MANAGEMENT.md#save-an-on-demand-connection), the [user guide](docs/USER_GUIDE.md), and [release notes](docs/releases/0.32.0.md).

## 0.31.0 — 2026-10-27

- Add a close control to every Home section: Introduction, Quick connect, Recent sessions, Sessions, Network tools, and Keyboard.
- Add **Customize Home** to choose visible sections and restore all sections, including when Home is otherwise empty.
- Retain Home visibility choices across reopening, layout changes, and application restarts; new profiles and upgrades from 0.30.0 or earlier initially show all sections.
- Keep saved sessions, recent history, active connections, and tools intact when a Home section is hidden.

See [Customize Home](docs/USER_GUIDE.md#customize-home), the [user guide](docs/USER_GUIDE.md), and [release notes](docs/releases/0.31.0.md).

## 0.30.0 — 2026-10-26

- Add five animated application themes: **Ion Storm**, **Solar Flare**, **Aurora Flux**, **Hyperdrive**, and **Ghost Circuit**, each with distinct glow, motion, and coordinated terminal/editor colors.
- Add electrical arcs, a solar corona, aurora curtains, a starfield, and circuit traces behind terminal and editor output, with quieter surfaces for tools and explanations.
- Retain header and Appearance pause/resume controls and Windows reduced-motion support. Pausing keeps the chosen colors and decorative background visible.
- Support all five workspace layouts, floating panels, and native pop-outs while preserving explicit terminal palettes and per-session overrides.
- Pause theme animation when a native pop-out is hidden or minimized, using that window's own visibility; resume when it becomes visible if motion is enabled.
- Keep all 13 earlier themes and saved appearance preferences. KonX now offers 18 application themes, including 11 animated choices.

See the [theme guide](docs/THEMES.md), [user guide](docs/USER_GUIDE.md#appearance-and-motion), and [release notes](docs/releases/0.30.0.md).

## 0.29.0 — 2026-10-26

- Add five static application themes: **Obsidian Gold**, **Arctic Glass**, **Deep Ocean**, **Sandstone**, and **Crimson Circuit**.
- Coordinate application surfaces, terminal palettes, and Notepad colors with the new themes; Arctic Glass and Sandstone include light terminal and editor backgrounds.
- Keep theme selection independent of workspace layout, with the same appearance in docked, floating, and popped-out panels.
- Match Events and Site Workspace error/selection colors to the active theme and keep packet warning rows readable in the new light themes.
- Preserve existing application themes, explicit terminal palettes, per-session overrides, and saved appearance preferences when upgrading. The six animated themes retain their existing motion controls.

See the [theme guide](docs/THEMES.md), [user guide](docs/USER_GUIDE.md#appearance-and-motion), and [release notes](docs/releases/0.29.0.md).

## 0.28.0 — 2026-10-26

- Move **Update KonX** from Home to the top-right header, available in every workspace layout; keep **Settings → Updates**.
- Replace the terminal right-click dropdown with a clear **Paste clipboard on right-click** checkbox. Preserve the existing menu/paste choice and multiline-paste confirmation; new profiles keep the menu by default.
- Clarify the automatic selection-copy control and retain existing clipboard preferences.
- Fix rapid highlight/copy timing and prevent pending clipboard reads or multiline confirmations from pasting into a replacement connection.

See the [terminal guide](docs/USER_GUIDE.md#copy-paste-search-and-links), [update guide](docs/UPDATING.md), and [release notes](docs/releases/0.28.0.md).

## 0.27.1 — KonX-AI and Saved Provider Keys

- Rename the contextual assistant from Copilot to KonX-AI across current application labels and guides. Existing local conversations and workspace references remain compatible.
- Improve encrypted local API-key management, saved-key visibility, reuse and deletion.
- Retain entered keys after failed saves, protect unsaved connection edits, refresh an open KonX-AI panel after settings changes, and retain pending encrypted-file cleanup through shutdown retry.

See the [KonX-AI guide](docs/KONX_AI.md) and [release notes](docs/releases/0.27.1.md).

## 0.27.0 — 2026-10-23

- Review and run a bounded single-target Ping, DNS query or Traceroute from a completed Copilot answer.
- Review an exact editor selection replacement, then recheck the live model, version and selection before one undoable edit; no automatic save or upload.
- Save an exact answer or selected excerpt as a new local Knowledge note, with provenance.
- Retain action targets, review digests and outcomes. Expired, stale and replayed reviews are rejected; uncertain outcomes never trigger an automatic retry.
- Avoid the reproduced Windows initial hard-link publication failure with an exclusive native move for new Copilot, Incident, Change Validation and saved-site files, preserving collision and cleanup ownership checks.

See the [Copilot guide](docs/KONX_AI.md) and [release notes](docs/releases/0.27.0.md).

## 0.26.0 — 2026-10-23

- Add explicit device, snapshot, topology, event, site, incident, completed runbook and change-validation evidence choices in Copilot.
- Preserve source references, collection times, selections, uncertainty and whole-value omission notices without automatically collecting or opening evidence.
- Serialize incident reads and writes, retain failed cleanup ownership, and guard shutdown and updates against pending incident operations.
- Retry transient Windows file-replacement failures within a bounded interval, validating both source and destination identity/version before every retry.

See the [Copilot guide](docs/KONX_AI.md) and [release notes](docs/releases/0.26.0.md).

## 0.25.0 — 2026-10-23

- Add selected packet, readable stream, SIP/SDP, RTP quality, capture comparison and remote-capture evidence to Copilot.
- Add selected security, Wi-Fi and Mist observations with original scope, frame references, coverage and omissions.
- Attaching existing results performs no new capture, parsing, cloud query, audio export or file read.

See the [Copilot guide](docs/KONX_AI.md) and [release notes](docs/releases/0.25.0.md).

## 0.24.0 � 2026-10-23

- Add explicit terminal selection/viewport and connection diagnostics, including serial detection, logging and configured forwards.
- Add saved-session context, SFTP listing/selection/transfer metadata, and current editor selections or documents.
- Add the current-view evidence picker; attachments remain local, bounded and immutable, with no automatic commands, transfers or provider requests.

See the [Copilot guide](docs/KONX_AI.md) and [release notes](docs/releases/0.24.0.md).

## 0.23.0 — 2026-10-23

- Add a contextual Copilot using existing companion panes, floating panels, and native pop-outs.
- Save bounded local conversations with immutable selected evidence, retained sources, and explicit follow-up history.
- Require exact request review before provider calls; validate revision, expiry, and single-use review at send.
- Add explicit provider connection tests, actual reported token usage, cancellation, interrupted-request handling, and shutdown ownership.
- Capture typed basic network tool facts from their original run inputs and selections, with coverage and omission notices.

See the [Copilot guide](docs/KONX_AI.md) and [release notes](docs/releases/0.23.0.md).

## 0.22.1 — 2026-10-23

- Redact complete bounded AI context before shortening it; disclose omitted fields, records, and excerpts instead of silently losing evidence.
- Protect unsent questions, context edits, and knowledge-note drafts when closing AI or preparing an update. Cancelled and failed actions preserve editable input.
- Keep existing provider destinations, encrypted credentials, explicit sharing, and offline library behavior.

See the [AI guide](docs/AI_KNOWLEDGE_GUIDE.md) and [release notes](docs/releases/0.22.1.md).

## 0.22.0 — 2026-10-23

- Add saved Guided Change Validation workflows from plan and baseline through manual maintenance, after evidence, and explicit review.
- Reuse snapshot comparison and reviewed Runbook/Capture Comparison reports with retained source references and uncertainty.
- Record user decisions with rationale and evidence references; changing inputs invalidates assessments without inferring a health verdict.
- Add complete JSON/HTML exports and independent incident copies guarded by reviewed revisions, plus draft, file-boundary, and shutdown protection.

See the [validation guide](docs/CHANGE_VALIDATION.md) and [release notes](docs/releases/0.22.0.md).

## 0.21.0 — 2026-10-23

- Add Live Events with explicitly started IPv4/IPv6 UDP syslog and SNMPv1/v2c trap receivers.
- Parse readable headers, structured fields, numeric OIDs and typed varbinds while preserving unknown source times and unsupported formats. SNMP community bytes and raw packets are excluded.
- Add bounded searchable history, filters, click-through details, exact saved-host matches, reviewed JSON/text exports, and selected incident evidence.
- Keep listener ownership through stop, late close, cleanup failure, application shutdown, and updater checks.
- Prevent workspace exports through Windows folder aliases from overwriting the managed workspace library; retain exact-limit file readability.

See the [event console guide](docs/EVENTS.md) and [release notes](docs/releases/0.21.0.md).

## 0.20.0 — 2026-10-23

- Add interactive Visual Topology from canonical CDP/LLDP, interface, ARP, and MAC observations with clickable source evidence.
- Reuse Device Inspector reports and saved snapshots; show stale, unknown, ambiguous, and omitted observations explicitly.
- Add candidate endpoint overlays, drag/keyboard arrangement, zoom/fit, bounded incident evidence, and JSON export/import with original command evidence.
- Keep device connections explicit and offer only a count/coverage summary to AI.

See the [topology guide](docs/TOPOLOGY.md) and [release notes](docs/releases/0.20.0.md).

## 0.19.0 — 2026-10-23

- Add Saved Site Workspaces with grouped session references, notes, capture paths, incident links, and named panel arrangements.
- Restore passive panels while retaining existing work; preserve terminal/SFTP mode and require explicit connection or file-open actions.
- Add duplicate/import/export/delete, strict reference-only schemas, revision conflict checks, atomic saves, and owned file cleanup through shutdown.
- Retain failed/cancelled drafts and protect unsaved workspace definitions during tab close and updating.

See the [site workspace guide](docs/SITE_WORKSPACES.md) and [release notes](docs/releases/0.19.0.md).

## 0.18.1 — 2026-10-23

- Add a local **Report a problem** preview and JSON export on Home and Settings → Support. Error logs are bounded and opt-in; nothing is uploaded automatically.
- Return incident evidence from the committed manifest instead of rereading it after a successful save. Preserve failed drafts and show explicit save results.
- Recover pop-out windows into available display work areas and expand fractional-scale checks.
- Fix inherited AI reference redaction/excerpt, Wi-Fi security-advertisement, HSTS directive, and stored Cisco macro assessment defects.

See [Tester support](docs/TESTER_SUPPORT.md) and [release notes](docs/releases/0.18.1.md) for validation and remaining coverage.

## 0.18.0 — 2026-10-22

- Float open tabs inside KonX, drag their headers, resize all edges/corners, and maximize, restore, or dock them.
- Add separate native pop-out windows for live views; Windows X returns a panel to the workspace without reconnecting or replacing its state.
- Add resizable split dividers, stable tab dragging, existing-pane drops, geometry persistence, and Reset workspace.
- Keep terminal input, mouse reporting, editor models, packet details, themes, menus, and dialogs working across window moves.
- Retain child-window ownership through redocking and shutdown, and restrict application IPC to the main renderer frame.

See the [workspace guide](docs/WORKSPACE_LAYOUTS.md) and [release notes](docs/releases/0.18.0.md).

## 0.17.0 — 2026-10-22

- Add **Auto detect** for serial baud rate, including saved sessions and Quick Connect.
- Listen for readable console output by default, with an explicit Enter-probe option for quiet consoles and a fresh sample required before connecting.
- Report progress, the selected numeric rate, and unresolved silent or ambiguous results while preserving fixed-rate settings and other serial framing options.
- Cancel detection on disconnect, suppress unconfirmed output and input, and clean up failed or late serial connections.
- Preserve the initial serial prompt for automatic logging and saved logon actions; retain unfinished driver cleanup for retry before exit or update.

See the [serial auto baud guide](docs/SERIAL_AUTO_BAUD.md) and [release notes](docs/releases/0.17.0.md).

## 0.16.1 — 2026-10-22

- Replace the updater's temporary `payload.exe` name with `KonX-Setup-<version>.exe` for installed updates and `KonX-<version>-portable.exe` for portable updates.
- Validate the target version and exact handoff filename while retaining checksum verification, cancellation, cleanup, and recovery.
- Explain that older clients may show the old name once when installing this fix; updates started from 0.16.1 use the branded filename.

See the [update guide](docs/UPDATING.md) and [release notes](docs/releases/0.16.1.md).

## 0.16.0 — 2026-10-22

- Add automatic Cisco output highlighting for errors, warnings, interface up/down states, and validated IPv4/IPv6 addresses.
- Provide a live **Cisco colors** switch, a global default, and saved per-session overrides independent of terminal palettes.
- Decorate interpreted terminal cells while retaining remote colors, original clipboard/export text, and text-file logs.
- Recompute visible highlights after output, wrapping, scrolling, resizing, and screen rewrites; bypass alternate-screen applications and bound retained display resources.

See the [Cisco highlighting guide](docs/CISCO_HIGHLIGHTING.md) and [release notes](docs/releases/0.16.0.md).

## 0.15.2 — 2026-10-22

- Put **Remember username and password** prominently beside the session editor's login fields, with visible saved-password status and explicit removal.
- Add a masked password field and opt-in **Save session and remember login** checkbox to Home Quick Connect for SSH, Telnet, and SFTP.
- Save selected Quick Connect credentials through the existing encrypted session store before connecting; leave unchecked logins transient and forward one-time passwords to SFTP.
- Prevent duplicate saves, preserve populated forms after save failures, and avoid opening late connections after Home closes.
- Keep existing saved-password retention, one-time overrides, and explicit removal behavior; username remains part of saved sessions.

See the [session management guide](docs/SESSION_MANAGEMENT.md) and [release notes](docs/releases/0.15.2.md).

## 0.15.1 — 2026-10-22

- Add a visible **Log to text file** switch to each console, with a green On indicator confirmed by the backend, the saved path, and a folder button. Keep state coherent across switch clicks, context-menu actions, tabs, layouts, failures, and disconnects.
- Confirm the log file opens before reporting active logging. Use unique `.txt` filenames by default, preserve explicit saved templates, and record only new output; automatic session logging remains available.
- Add a per-session **SSH transport compatibility** choice: Automatic prefers modern algorithms and permits supported legacy choices; Modern transport only excludes legacy transport. Apply one policy to terminals, SFTP, jump hosts, and SSH audits.
- Load OpenSSH, traditional PEM, PKCS#8, and PuTTY v2/v3 private keys, including supported encrypted RSA, ECDSA NIST P-256/P-384/P-521, and Ed25519 identities. Decode PPK v3 Argon2d/i/id in a bounded worker and verify key integrity.
- Explain unsupported keys and crypto capabilities explicitly. Windows Electron cannot use DSA (`ssh-dss`); SSH 1, FIDO key files, OpenSSH certificates, and Ed448 remain unsupported.
- Report invalid key paths, passphrases, formats, integrity, and resource limits before connecting instead of silently falling back to password authentication. Unlock keys before the network timeout starts, without rewriting their files.
- Cancel pending username/key prompts, key workers, logins, and jump forwarding; ignore late answers after timeout or closure and avoid saving a late host-key decision.
- Report negotiated legacy transport in terminals and SSH audits while preserving host-fingerprint verification for authenticated connections.
- Pin and verify a narrow `ssh2` 1.17.0 native group1 compatibility patch for Electron's missing named `modp2` group.

See the [SSH compatibility guide](docs/SSH_COMPATIBILITY.md) and [release notes](docs/releases/0.15.1.md) for supported scope and validation.

## 0.15.0 — 2026-10-22

- Clear recent session history from Home without deleting saved sessions, credentials, open connections, or unrelated preferences.
- Preserve Home Quick connect input when clearing history or returning to Home, and tolerate malformed recent-history storage.
- Wrap Home Quick connect fields in narrow workspace panes so Host and Port remain readable and usable.
- Group username, password, and encrypted password saving on the session editor's General page.
- Keep blank edits from removing saved credentials, provide explicit password removal, and support one-time passwords with Save & Connect.
- Reject failed encryption or persistence without partially changing saved sessions or folders; keep the editor open for retry.
- Reconcile completed saves after dialog closure without opening a late connection.

See the [session management guide](docs/SESSION_MANAGEMENT.md) and [release notes](docs/releases/0.15.0.md).

## 0.14.0 — 2026-10-21

- Add four physical workspace arrangements to Appearance: Workbench, Incident Desk, Operations Wall, and Focus Workspace, with structural previews and Classic as the existing-profile default.
- Select layout independently of application colors, animation, reduced motion, and terminal palette overrides.
- Arrange the same open tool/session instances into panes, with explicit selection, command focus, and expansion.
- Preserve captured data, drafts, ongoing connections, close confirmations, and updater blockers across layout changes.
- Prevent background connection notifications and delayed visibility callbacks from stealing keyboard focus.
- Keep toolbar actions visible at the minimum window width and make compact tool panes scrollable and expandable.
- Stabilize local SSH test identities with native RSA/PKCS1 serialization after reproducing malformed keys from the fixture's previous Ed25519 generator.

See the [workspace layout guide](docs/WORKSPACE_LAYOUTS.md) and [release notes](docs/releases/0.14.0.md).

## 0.13.0 — 2026-10-21

- Compare working and failing capture files or retained snapshots of stopped capture tabs, with a synthetic demo.
- Inspect DNS answers/codes/timing, TCP setup/resets/duplicate-sequence candidates, and plaintext HTTP/1 status/timing.
- Match exact service identities or select explicit mappings; preserve changed, same, unknown, and unmatched observations.
- Navigate to retained source packets on either side, export comparison JSON, add reports to incidents, and share summary-only AI context.
- Preserve unknown packet timestamps and source coverage through viewing, capture/SIP export, and incident attachment; disclose bounded reads and incomplete records.
- Keep mixed timing uncertainty, DNS question identity, and PCAPNG timestamp offsets in the owning analysis path.
- Honor unknown capture times in SIP timing, RTP jitter, RTCP arrival observations, and paired audio alignment while retaining RTP-clock mono reconstruction.

See the [comparison guide](docs/CAPTURE_COMPARISON.md) and [release notes](docs/releases/0.13.0.md).

## 0.12.0 — 2026-10-21

- Run reviewed gateway, slow-application, and phone-audio procedures with explicit typed targets.
- Collect sequential DNS, ping, TCP, and fixed device-inventory observations with pass/fail/unknown evidence, deadlines, cancellation, and result export.
- Open explicitly selected existing SIP/RTP captures for manual steps without inventing a diagnosis or passing the step automatically.
- Import, review, save, update, export, and remove custom JSON procedures in a local library.
- Protect unsaved definitions and await owned probe/file cleanup during closing and updating.
- Prevent updater installation while a known remote-capture or runbook cleanup failure still needs retry.

See the [runbook guide](docs/RUNBOOKS.md) and [release notes](docs/releases/0.12.0.md).

## 0.11.0 — 2026-10-21

- Collect bounded Linux packet captures through a separate channel of an existing SSH session, with explicit interface, filter, duration, and packet limits.
- Stream complete PCAP records into local files, preserve usable partial captures, and disclose remote exit and termination uncertainty.
- Verify retained results before opening; export collection reports or explicitly remove registered captures.
- Keep the existing terminal available, protect running work during tab closing and updating, and await capture/file cleanup before application exit.

See the [remote capture guide](docs/REMOTE_CAPTURE.md) and [release notes](docs/releases/0.11.0.md).

## 0.10.0 — 2026-10-21

- Create local incident workspaces for captures, selected terminal output, tool results, imported syslog, and notes.
- Snapshot current-tab evidence into an explicit pending item before choosing its destination and saving it.
- Retain independent asset copies, SHA-256 integrity checks, source line references, and timelines with unknown timestamps preserved.
- Export escaped HTML and structured JSON reports; reopen verified captures for packet, SIP, and RTP analysis.
- Keep raw incident evidence out of AI summary context and protect unfinished incident work during tab closing and updater restart.
- Report the actual bound SSH forwarding port when the operating system assigns it, and remove the test fixture's random-port collision risk.

See the [incident guide](docs/INCIDENT_WORKSPACES.md) and [release notes](docs/releases/0.10.0.md).

## 0.9.0 — 2026-10-21

- Open RTP Media from Packet Capture or a SIP call, with directional streams, SDP associations, jitter, gaps, duplicate/reordered packets, and source-frame navigation.
- Inspect RTCP sender and receiver reports without inventing unknown clock conversions or listener quality scores.
- Build G.711 waveforms, play one or two directions explicitly, and export PCM16 WAV files. Paired playback uses capture timestamps; gaps remain marked silence.
- Load a synthetic SIP/RTP tone demo directly in the media view.
- Stop audio when the media dialog closes or its capture is replaced. Keep unsupported, encrypted, ambiguous, and limited observations explicit.

See the [RTP media guide](docs/RTP_MEDIA.md) and [release notes](docs/releases/0.9.0.md).

## 0.8.0 — 2026-10-21

- Save named, immutable device snapshots and reopen them from local history.
- Compare interfaces, VLANs, neighbors, routes, and configuration before and after maintenance, with original evidence and explicit unknowns for incomplete collection.
- Opt in to running-configuration and route collection without changing ordinary inventory collection.
- Try a synthetic before/after demo and retain or delete its library entries.
- Exclude raw configuration and comparison bodies from AI context.

See the [snapshot guide](docs/DEVICE_SNAPSHOTS.md) and [release notes](docs/releases/0.8.0.md).

## 0.7.0 — 2026-10-21

### Added

- Device Inspector collects fixed Cisco IOS/IOS-XE show commands using a separate channel on selected connected SSH sessions. Search interfaces, VLANs, MAC and ARP tables, CDP/LLDP neighbors, and PoE observations with command/line evidence.
- IP/MAC tracing correlates the selected devices' observations, preserving ambiguous matches, unresolved uplinks, and candidate edge ports rather than claiming a confirmed physical endpoint.
- Synthetic offline demo, JSON report import/export, collection cancellation, and access to the original connected terminal.
- A phased roadmap covering snapshots, RTP analysis, incidents, remote capture, runbooks, and capture comparisons. Later phases are not included in 0.7.0.

See the [Device Inspector guide](docs/DEVICE_INSPECTOR.md) and [0.7.0 release notes](docs/releases/0.7.0.md) for validation and supported scope.

## 0.6.3 — 2026-10-21

### Release verification

- A version-only release carrying the same application and updater source as 0.6.2, providing a newer public target for the complete installed update workflow. No new application features or updater fixes are introduced.
- Updated download links, release notes, and user guides. Installed 0.6.2 and portable 0.6.0 or later copies can use **Update KonX**; installed 0.6.0/0.6.1 copies need a manual upgrade to 0.6.3.

Before publication, the released 0.6.2 installer was manually installed and its update button successfully checked the public release with the existing settings unchanged. A full installed 0.6.2 → 0.6.3 download, installation, restart, and settings comparison requires 0.6.3 to be published first. See the [0.6.3 release notes](docs/releases/0.6.3.md#validation) for validation and coverage limits.

## 0.6.2 — 2026-10-21

### Fixed

- Installed updater detection now checks the physical `app.asar` file rather than Electron's virtual archive directory.
- Installed update handoff reads the installer location and uninstall registration from electron-builder's separate registry keys, validating the application identity, directory, and installation mode together.
- Regression coverage now includes Electron's real ASAR filesystem behavior and the actual installer registry layout. The original 0.6.0/0.6.1 installed update button is affected; portable updating is unaffected. Installed copies need one manual upgrade to 0.6.2.

### Documentation

- Updated the release notes, download links, user guide, and update guide for 0.6.2. Installed 0.6.0/0.6.1 copies need one manual upgrade to 0.6.2; portable copies can use **Update KonX**.

Validation: 0.6.2 passed 485 automated tests. Installer and portable builds completed, all 81 packaged source files match the release source, and isolated packaged startup/restart and updater-control checks passed. Corrected source components completed a real all-users NSIS update from installed 0.6.0 to the published 0.6.1 installer, preserving the installation folder/mode and settings bytes and restarting KonX as 0.6.1. This is a component handoff test; the original installed button failed. See the [0.6.2 release notes](docs/releases/0.6.2.md#validation) for coverage limits.

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
