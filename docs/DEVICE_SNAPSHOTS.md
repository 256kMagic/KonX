# Device snapshots and change checks

Available from KonX 0.8.0 under **Network Tools → Device Snapshots**.

## Capture before and after a change

1. Open the relevant SSH terminals and collect observations in **Device Inspector**.
2. Select **Include configuration and routes** when you also need `show running-config` and `show ip route`. Leave it off for the ordinary inventory collection.
3. Save the report as a named snapshot, for example “Before maintenance”.
4. After your change, collect the same devices again and save another snapshot.
5. Open **Device Snapshots**, choose the before and after snapshots, and compare them.

Snapshots are immutable records. Saving again creates another entry; it does not replace an earlier snapshot. Collection timestamps describe the observations, while the saved timestamp records when the snapshot entered the library.

## Explore a demonstration

Choose **Load demo comparison** to create two named synthetic snapshots and compare them. This does not contact switches. The demo contains deliberate interface, route, and configuration changes. You can open either report in Device Inspector or remove the demo entries afterward.

## Read a comparison

Use category and change filters to review interfaces, VLANs, neighbors, routes, and configuration. Inspect the original before and after command evidence for a selected change.

Matching uses device identities rather than transient terminal-tab IDs. Unmatched or ambiguous devices remain visible. Missing commands, unsupported layouts, and incomplete output produce unverified comparisons rather than claiming that every absent row was removed.

Configuration differences describe captured text and sections; they are not a simulation of forwarding behavior or proof that a change is safe. Counter differences are observations and can reflect resets or intervening activity. Collection does not apply changes or perform rollback.

## Storage and sharing

Snapshots are stored in the current KonX profile's `device-snapshots` directory. They retain original command output. Running configurations may contain credentials or sensitive network details; they remain local files and are not encrypted by the snapshot library. Protect the profile and review reports before sharing.

**Explain with AI** for a snapshot comparison uses a summary of metadata and counts. Original configuration text and before/after command transcripts are excluded. Device Inspector also excludes command transcripts from its AI context.

Delete a snapshot only when its evidence is no longer needed. Deleting a library entry does not modify a switch or an independently exported report. Corrupt or unreadable stored entries are reported instead of silently treated as an empty history.
