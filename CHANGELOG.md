# Changelog

## Unreleased

### Added

- Security Suite tab with local Windows posture checks and a remote Windows TCP-exposure profile.
- TLS/certificate, pre-authentication SSH, web-header, and single-host service-exposure assessments.
- Offline Cisco-style configuration and saved PCAP/PCAPNG security findings with redacted line/frame evidence.
- Result filters, evidence and recommendations, explicit unknown states and scope limits, local opt-in baselines, and JSON/HTML report exports.
- Bounded collection and cancellation when stopped or closed, plus unit, loopback-network, synthetic-file, and real Electron workflow regression coverage.
- Local JavaScript error logs for the next development build, including startup failures, uncaught main-process errors, and unhandled-rejection warnings. The original Electron error handling remains active; logs rotate at 128 KiB and individual entries are bounded to 16 KiB.

See the [Security Suite guide](docs/SECURITY_SUITE.md). These source changes are not included in the installed 0.2.1 test build or the published 0.2.0 executables.

Validation: 348 automated tests pass, including 56 new security checks and 13 diagnostics/boot checks using synthetic inputs, loopback services, and isolated real Electron processes. Error-logging tests cover fatal exceptions, warning-only rejections, startup failures, rotation, size limits, and failed log writes while preserving the original error handling. A separate local Windows smoke test completed all 14 posture checks at the current user's permission level; inaccessible firmware/encryption checks remained unknown.

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
