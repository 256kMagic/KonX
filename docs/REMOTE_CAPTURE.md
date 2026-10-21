# Remote packet capture

Available from KonX 0.11.0 under **Network Tools → Remote Capture**. Capture on an existing Linux SSH connection and investigate the retained file in KonX.

## Requirements

Open an SSH terminal to the Linux host first. That host must already have `tcpdump` and GNU `timeout`, and the connected account must already have permission to capture on the chosen interface. KonX does not install tools or request `sudo`. Select a Linux connection explicitly; Cisco device sessions are not suitable for this command.

## Start and stop

1. Open **Remote Capture** and refresh the connected SSH sessions.
2. Select the host, an interface such as `any` or `eth0`, duration, packet limit, and optional BPF expression.
3. Start collection. A separate SSH execution channel streams classic PCAP directly to a local file. The existing terminal remains available.
4. Use **Stop** to request termination early. Wait for channel and local-file cleanup before closing the tab or updating KonX.
5. Review packet count, committed bytes, remote exit information, diagnostics, and coverage notes. Open the retained capture in Packet Capture for readable traffic, SIP, and RTP analysis.

Save a PCAPNG from Packet Capture or add the capture to an incident if you need a lasting investigation record. A tool report added directly to an incident contains collection metadata; open the capture and use its **Add to incident** action to retain packet bytes.

## Limits and interpretation

Duration is 1–300 seconds, packet count is 1–100,000, and each local file is limited to 64 MiB. Only complete PCAP records are committed and counted. If collection stops during a record, the complete prefix remains usable and the omitted tail is disclosed.

The report's completion status describes this bounded operation. It does not prove that every network packet was observed. The kernel, capture location, filter, permissions, transport, and duration all affect what is available. Remote stderr and exit status remain visible.

Stop signals the dedicated channel and closes it after a grace period. Some SSH servers do not forward process signals or return exit status. In that case remote termination remains explicitly unconfirmed; GNU `timeout` independently bounds the requested command. KonX does not terminate the borrowed SSH client or other terminal channels.

## Retained files

Files are stored under the current KonX profile's `remote-captures` directory with UUID names. Opening a current result verifies its registered bytes and SHA-256 digest before returning them to the viewer. Explicit deletion removes only that registered capture and requires confirmation.

One KonX process retains at most 128 registered results, including captures still starting. Remove a retained result to make room, or save your work and restart to release the session registrations. If local cleanup fails, KonX retains ownership, reports the failure, and requires cleanup to finish before another remote capture starts.

Result buttons belong to the current KonX process. Closing a tab or restarting does not silently delete its local PCAP, but a prior result's button is not restored. Open the file manually from the profile directory, or save it to your chosen location before closing. Remove old retained files when no capture is running if they are no longer needed. Packet data is stored as ordinary local files, not an encrypted archive.
