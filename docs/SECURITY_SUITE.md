# KonX Security Suite

The Security Suite is included in KonX 0.3.0. Open **Security Suite** from Home, the sidebar, or the **Network Tools** menu. Opening a tab does not start an assessment. Choose an assessment, enter its target or select a local file, then click **Run assessment**. **Cancel assessment** stops the active job; closing its tab also cancels it.

## Assessments

| Assessment | Input | What it checks |
| --- | --- | --- |
| **Windows — this PC** | No target needed | 14 local checks: antivirus protection, Defender signature age, three effective firewall profiles, SMBv1 server, SMB server/client signing, Remote Desktop/NLA, UAC, Secure Boot, OS-drive BitLocker, hotfix inventory, and aggregate local-account policy. |
| **Windows — remote service exposure** | One hostname or IP | TCP reachability of 135, 139, 445, 1433, 3389, 5985, and 5986 from this PC. It does not log in or inspect remote Windows settings. |
| **TLS & certificate auditor** | Hostname/IP and port, normally 443 | Certificate chain trust, hostname/IP match, validity dates, fingerprint, public-key metadata, and the negotiated TLS protocol/cipher. Use the intended DNS hostname for SNI. |
| **SSH security auditor** | Hostname/IP and port, normally 22 | One pre-authentication handshake, observed host-key fingerprint, and negotiated algorithms. No credentials, login attempt, shell, or remote commands are sent. |
| **Web security headers** | Complete HTTP/HTTPS URL | Transport/certificate observations, HSTS, MIME sniffing protection, referrer policy, CSP, framing policy, and aggregate cookie protection attributes. |
| **Service exposure review** | One hostname or IP | A fixed set of 16 common management, database, and web TCP ports. Open ports are observations to review, not confirmed vulnerabilities. |
| **Device configuration auditor** | Pasted text or a local file; optional report label | Explicit Cisco IOS/IOS-XE/NX-OS-style settings for legacy management, credential storage, SNMP, SSH, AAA, logging, and NTP. Evidence contains rule descriptions and line numbers. |
| **Saved capture security findings** | Local PCAP/PCAPNG file | Supported observations including cleartext authentication, legacy management protocols, old TLS, and selected ARP/DHCP anomalies, with source frame numbers. |

The local Windows assessment runs fixed read-only PowerShell queries as the current user. It neither changes settings nor requests administrator elevation. Restricted, missing, or unsupported components remain **Unknown**. It collects aggregate settings rather than account names, passwords, BitLocker keys, or recovery material. Hotfix inventory cannot establish that Windows is fully patched; registered third-party antivirus does not prove that provider is healthy. This assessment does not run an antivirus malware scan.

Remote exposure checks identify reachable TCP ports, not the operating system or service behind them. A conventional SMB port does not establish SMB dialect, signing policy, or CVE status. Results depend on the source PC, firewall, route, and collection time. Use the remote Windows profile for exposure, then run the local assessment on that Windows host for its posture.

TLS and SSH results describe one negotiated connection. They do not enumerate every algorithm a server accepts. TLS trust uses the KonX runtime trust store, which can differ from Windows or a browser. The SSH key is observed without adding it to KonX's saved connection trust records; verify its fingerprint through a trusted channel.

The web check sends unauthenticated HEAD requests, using a header-only GET fallback for HTTP 405/501. URL queries and fragments are removed before requests. It follows at most three redirects within the selected hostname, reports HTTPS downgrades without following them, and discards bodies. It does not load scripts/resources, retain cookies, or log in. Header recommendations require application context; a header's presence alone does not prove an effective policy.

## Read findings

Each row includes a result, severity, and confidence. Select it to read the evidence, recommendation, and a reference where available. The filter switches between failed checks, warnings, unknown results, passes, and information.

- **Fail:** a stated check observed a concrete failed condition.
- **Warning:** review the observed setting or exposure in your environment.
- **Unknown:** collection was unavailable or evidence was insufficient. It is not a pass.
- **Pass:** the specific stated check passed. It does not certify the whole device.
- **Info:** contextual evidence without a general security verdict.

Configuration defaults, inherited policies, ACLs, and incomplete snippets can change effective behavior. Unsupported configuration families are marked Unknown. Capture anomalies are evidence to investigate, not proof of an attack; encrypted traffic and missing packets limit visibility. Use frame numbers to inspect the original capture in Packet Capture.

From 0.18.1, Cisco configuration review skips stored `macro name` bodies through the standalone `@` terminator. Unapplied macro commands do not count as active configuration; an incomplete definition is reported as a limitation. Web-header review interprets the first HSTS header with quoted values and directive uniqueness, so duplicate or malformed directives do not establish a valid policy.

## Baselines and exports

1. Run an assessment and review its scope and limitations.
2. Click **Set baseline** to save that report in the current KonX profile. Nothing is saved as a baseline automatically.
3. Run the same assessment for the same target again and click **Compare baseline**. The table marks new, changed, and unchanged checks. A missing check is counted as **no longer reported**, not fixed.
4. Click **Export JSON** for structured results or **Export HTML** for a standalone readable report, then choose a destination.

Up to ten target baselines are retained locally, subject to a storage limit. Comparison includes status, severity, and evidence; collection timestamps alone do not count as changes. A distinct, stable label is required to enable baselines for pasted configurations; unlabeled text can still be assessed and exported. Selected file paths identify the baseline scope internally but are not written into assessment findings. Changing the file location starts a different scope.

Reports include target, timestamp, scope, evidence, recommendations, and collection limitations. Configuration reports omit raw configuration lines, credential values, and account names. Capture reports omit payloads and decoded credential values. Web reports omit cookie names/values and URL queries. Review target labels and hostnames before sharing exports. Reports and baselines are not uploaded automatically.

## Limits and troubleshooting

- Windows inventory has a 45-second deadline and 1 MiB output bound. Access-denied checks can be reviewed separately in Windows Security or your managed endpoint console.
- Exposure checks use at most four concurrent sockets and one host. Connection refusal is reported separately from a timeout or routing error.
- Web response headers are limited to 32 KiB and the whole redirect assessment has a bounded deadline.
- Local configuration/capture files are limited to 32 MiB; files changing during collection are rejected. Configuration review is bounded to 100,000 lines and capture review to 50,000 packets. Oversized packet records and incomplete coverage are reported explicitly.
- A TLS/SSH handshake failure remains Unknown. Check the hostname, service port, route, firewall, and protocol compatibility before retrying.

Implementation and regression tests are in `src/main/security/`, `src/renderer/js/security.js`, and `test/security-*-tests.cjs`. The suite uses existing KonX dependencies; no external scanner or additional driver is required.
