# KonX network workflow releases

Each phase ships separately with its own version, source commit, tests, Windows installer and portable executable, release notes, and updated user guide. Validation records distinguish automated fixtures from real equipment and live accounts.

| Phase | Version | Deliverable | Status |
| --- | --- | --- | --- |
| 1 | 0.7.0 | Device Inspector and IP/MAC switch-port tracing | Complete; 518 tests and packaged checks passed |
| 2 | 0.8.0 | Saved device snapshots and before/after change checks | Complete; 537 tests and packaged checks passed |
| 3 | 0.9.0 | RTP analysis, G.711 playback, and WAV export alongside SIP calls | Complete; 564 tests and packaged checks passed |
| 4 | 0.10.0 | Incident workspaces, evidence timeline, notes, and reports | Complete; 595 tests and packaged checks passed |
| 5 | 0.11.0 | Bounded remote packet capture through SSH | Complete; 641 tests and packaged checks passed |
| 6 | 0.12.0 | Diagnostic runbooks and saved procedures | Complete; 671 tests and packaged checks passed |
| 7 | 0.13.0 | Comparison of working and failing captures | Complete; 716 tests and packaged checks passed |

## Workspace follow-on

Version 0.14.0 adds Docked Workbench, Incident Desk, Operations Wall, and Focus Workspace alongside Classic. Layout choices reuse open sessions and tools and remain independent of the selected application theme. See the [workspace layout guide](WORKSPACE_LAYOUTS.md) and [release validation](releases/0.14.0.md).

Version 0.15.0 adds clearable recent session history and places username and encrypted password saving together on General in the session editor. See the [session management guide](SESSION_MANAGEMENT.md) and [release validation](releases/0.15.0.md).

Version 0.15.1 adds a visible per-console text logging switch and extends SSH 2 transport compatibility and private-key loading for terminals, SFTP, and jump hosts, with shared transport policy for SSH audits and explicit runtime limits. See [Session logging](USER_GUIDE.md#session-logging), the [SSH compatibility guide](SSH_COMPATIBILITY.md), and [release validation](releases/0.15.1.md).

Version 0.15.2 makes the session credential-retention checkbox prominent and adds opt-in saved logins to Home Quick Connect. See the [session management guide](SESSION_MANAGEMENT.md) and [release validation](releases/0.15.2.md).

Version 0.16.0 adds Cisco terminal highlighting with a live switch and saved global/session preferences. See the [highlighting guide](CISCO_HIGHLIGHTING.md) and [release validation](releases/0.16.0.md).

Version 0.16.1 gives staged update executables a KonX name and target version. See the [update guide](UPDATING.md) and [release validation](releases/0.16.1.md).

Version 0.17.0 adds serial baud-rate detection with explicit probing, visible progress, cancellation, and readable-output confirmation. See the [serial guide](SERIAL_AUTO_BAUD.md) and [release validation](releases/0.17.0.md).

Version 0.18.0 adds movable/resizable floating panels, split dividers, native pop-out windows, and dock-back controls while preserving live view ownership. See the [workspace guide](WORKSPACE_LAYOUTS.md) and [release validation](releases/0.18.0.md).

## Site workflow phases

The next approved sequence ships each phase with its own tested release, notes, and user guide:

| Version | Deliverable | Status |
| --- | --- | --- |
| 0.18.1 | Tester diagnostics, incident-save reliability, display-scale and window recovery checks | Complete; 900 tests and packaged checks passed |
| 0.19.0 | Saved site workspaces with session references, panel arrangements, notes, capture references, and explicit connection actions | Complete; 923 tests and packaged checks passed |
| 0.20.0 | Interactive topology from observed device neighbors and forwarding evidence | Complete; 936 tests and packaged checks passed |
| 0.21.0 | Explicitly started local syslog and SNMP trap event console | Complete; 959 tests and packaged checks passed |
| 0.22.0 | Guided before/after change validation using existing snapshots, runbooks, comparisons, and incident reports | Complete; 979 tests and packaged checks passed |

Saved workspaces must not connect, collect, or run commands merely by opening. Imports exclude credentials. Topology distinguishes observed, stale, and unresolved links. Event listeners start only on request and retain bounded history. Change validation coordinates reviewed checks around manual maintenance; it does not silently change device configuration.

## Contextual copilot phases

Each phase is tested and published separately with updated release notes and user guides. The assistant stays beside the active tool; evidence attachments and action targets remain explicit when focus changes.

| Version | Deliverable | Status |
| --- | --- | --- |
| 0.22.1 | Complete-context redaction, omission notices, and AI draft protection | Complete; 983 tests and packaged checks passed |
| 0.23.0 | Dockable copilot, conversations, complete request review, provider setup, and basic network context | Complete; 1,012 tests and packaged checks passed |
| 0.24.0 | Terminal, sessions, serial, forwarding, logging, SFTP, and editor assistance | In progress |
| 0.25.0 | Packet streams, SIP/RTP, capture comparison, security, Wi-Fi, and Mist assistance | Planned |
| 0.26.0 | Device, topology, events, sites, incidents, runbooks, and change-validation investigations | Planned |
| 0.27.0 | Reviewed diagnostic actions and editor patches with retained outcomes | Planned |

Opening a prepared tool is separate from starting work. Proposed actions show their target and inputs before execution. Collection, commands, file changes, and sharing remain explicit; observations, uncertainty, and evidence provenance stay visible.

## Collection scope

Device collection starts with connected Cisco IOS/IOS-XE SSH sessions and fixed read-only commands in a separate channel. Trace results show candidates and unresolved links when evidence is incomplete. Imported reports and a synthetic demo support offline use.

Snapshots retain original command output and timestamps. Comparisons separate changed facts from unavailable or unparsed observations.

Media analysis starts with offline unencrypted RTP and G.711. A missing packet or missing direction in a capture is an observation, not proof of a network fault. Encrypted SRTP is outside this phase.

Incident workspaces group explicitly added evidence and preserve source timestamps. Remote capture starts with existing Linux SSH connections and an installed tcpdump; no remote installation is performed.

Runbooks use declared checks and bounded collection. Capture comparisons preserve each capture's coverage and do not infer a unique root cause from differences alone.

The installed user profile is kept separate from automated test profiles. Real-device checks that need equipment or accounts are recorded as unverified until performed.
