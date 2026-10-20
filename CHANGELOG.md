# Changelog

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
