# Incident workspaces

Available from KonX 0.10.0 under **Network Tools → Incident Workspace**. An incident groups explicitly selected evidence in the local KonX profile: captures, terminal output, tool results, imported syslog, and notes.

## Start an investigation

1. Open **Incident Workspace** and create a workspace with a title and optional description.
2. Add a note, or choose an evidence type and import a file. Text imports must be UTF-8. Syslog is imported from files; this tool does not start a network listener.
3. In another diagnostic tool or Packet Capture, choose **Add to incident**. In a terminal, select the required text and use the tab's right-click **Add evidence to incident…** action.
4. Select the destination incident and press **Add pending evidence**. Opening the incident tab alone does not save the pending item.
5. Select an evidence item or timeline entry to inspect its original source information and text preview. Open a retained capture in Packet Capture to use readable traffic, SIP, or RTP analysis.

The capture action snapshots all retained packets in that tab, including packets hidden by its display filter. Terminal evidence contains only the selected text. Tool evidence uses that tool's collected report when available, otherwise its displayed text. Results over 256 KiB should be exported from their tool and imported as files.

## Timeline and evidence integrity

Each item has its original source name, observation time when supplied, import time, byte count, and SHA-256 digest. Assets are copied into the incident. Changing or deleting the original file does not change that retained copy.

Import time and observation time are different. A source timestamp with a complete date and explicit timezone can be placed chronologically. Traditional syslog timestamps that omit the year or timezone remain **Unknown**; KonX does not guess either value. Timeline entries retain source line references. Temporal proximity is not proof that one event caused another.

Retained bytes are checked before a capture is reopened or evidence is presented in a report. A checksum mismatch is visible. Malformed UTF-8 can remain valid retained binary evidence while its text preview is unavailable; that is distinct from an integrity failure.

Evidence and notes are appended. They do not overwrite earlier observations. Removing an entire incident requires confirmation and deletes its owned local copies, while leaving original imported files and independent exports untouched.

## Export and share

Export **HTML** for a readable standalone report or **JSON** for structured evidence metadata and bounded text. Both include timeline, provenance, integrity status, and coverage limits. HTML escapes evidence text and does not run captured markup or scripts.

Binary capture contents are not embedded in these reports. Open a retained capture and save it separately if the recipient needs packet bytes. Large text may be visibly truncated in the report while the retained asset remains complete. Review report contents before sharing: terminal output, configuration, syslog, and packet data can contain credentials or other sensitive values. Incident assets are ordinary local files, not an encrypted archive.

From 0.26.0, **Ask KonX-AI** offers explicit choices for selected complete text evidence, retained timeline entries, and integrity information. Truncated text is omitted with a notice; attachment does not reread the source file. Review the saved attachment and complete request before sending it to your provider. See the [KonX-AI guide](KONX_AI.md).

## Storage, limits, and unfinished work

Workspaces are stored in the KonX profile's `incidents` directory. Back up that directory along with the rest of the profile when no import or write is running.

Limits are 200 incidents, 128 evidence items and 512 MiB per incident, 128 MiB per binary file, 8 MiB per imported text file, and 256 KiB per pasted item. The timeline retains up to 1,500 entries and labels limited coverage. Text previews and exported text are bounded independently; the original retained file is preserved.

Save or discard draft fields and pending evidence before updating. The updater and tab-close action check for unfinished incident work. A forced process termination or operating-system shutdown can still discard unsaved drafts and pending captures; they are not persistent until explicitly added.

From 0.26.0, incident reads and writes are serialized, pending file ownership blocks shutdown/update completion, and failed cleanup stays available for retry. Transient Windows replacement errors receive a short bounded retry with file identity/version checks. Persistent locks and externally changed records produce an error; preserve the current evidence and resolve the reported issue before retrying.

