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

## Scope

Device collection starts with connected Cisco IOS/IOS-XE SSH sessions and fixed read-only commands in a separate channel. Trace results show candidates and unresolved links when evidence is incomplete. Imported reports and a synthetic demo support offline use.

Snapshots retain original command output and timestamps. Comparisons separate changed facts from unavailable or unparsed observations.

Media analysis starts with offline unencrypted RTP and G.711. A missing packet or missing direction in a capture is an observation, not proof of a network fault. Encrypted SRTP is outside this phase.

Incident workspaces group explicitly added evidence and preserve source timestamps. Remote capture starts with existing Linux SSH connections and an installed tcpdump; no remote installation is performed.

Runbooks use declared checks and bounded collection. Capture comparisons preserve each capture's coverage and do not infer a unique root cause from differences alone.

The installed user profile is kept separate from automated test profiles. Real-device checks that need equipment or accounts are recorded as unverified until performed.
