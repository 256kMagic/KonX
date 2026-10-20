# Changelog

## Unreleased

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
- Keep IP decoding inside its payload boundary, match DNS replies to the correct resolver, and trim overlapping TCP stream data after gaps.
- Deliver network-tool errors/results even when they arrive before the start reply, cancel tools closed during startup, and prevent duplicate starts from clearing active results.
- Start large port scans without allocating the entire host/port task matrix, and preserve completed traceroute summaries.

Validation: 159 automated tests pass, including 42 new regression checks. An isolated Electron smoke check covers stacked prompts, editor save/recovery, a failed tool start, a loopback ping, and capture-file loading.

## 0.1.2

- Fix connection-tab X clicks and clean up SSH connections closed during shell or forwarding setup.
- Include the prior SFTP path-validation, connection-error, prompt, editor-save, external-edit retry, and capture-lifecycle fixes.
- Publish the initial public repository, Windows x64 installer and portable executable, README, and user guide.
