# Reporting problems in KonX

Available from KonX 0.18.1. Choose **Report a problem** on Home or under **Settings → Support**.

Describe the steps, expected behavior, and actual result. Choose **Rebuild preview** to include the description. The preview is editable JSON: remove any information you do not want to share, then choose **Save report…**. Rebuilding replaces your preview edits. Cancelled or failed saves leave the preview available to retry.

The default report contains only KonX/runtime versions, installation mode, display sizes/scales, supported-feature flags, and activity counts. It does not read saved sessions, passwords, captures, terminal output, documents, the environment, or Knowledge notes.

**Include JavaScript error logs** is optional and off by default. After selecting it, choose **Rebuild preview**. Only the current and previous JavaScript error logs are considered, up to the first 16 KiB of each. Reports state whether the text is complete or a prefix and show unavailable/error states. Common credential patterns and local home/profile paths are masked on a best-effort basis. Logs may contain other identifying or sensitive information; review and edit the complete preview before sharing it.

Saving writes only the report you reviewed to the location you choose. Nothing is uploaded. **Open issue page** opens the project's issue form; you decide what to write and attach. Keep the JSON `kind` and `schemaVersion` fields when editing.

For useful tester feedback, include the KonX version, installed/portable mode, steps to reproduce, and screenshots with sensitive content removed. For window problems include monitor scaling and whether a monitor was disconnected. For connection problems include the device/software and key format without the key, passphrase, or password.

## Window checks

Native pop-outs recover into an available monitor work area when a display is removed or its work area changes. Minimized or maximized windows retain their state; recovery applies when restored. Automated display-scale tests simulate 100%, 125%, 150%, and 200% scales. They do not replace field testing with real mixed-DPI monitors or docking stations.

## Incident note saves

An unsuccessful save keeps the draft and reports the failure. Retry after correcting the reported problem. A successful evidence commit uses that committed state for its response, avoiding a second manifest read that could falsely report failure and encourage a duplicate retry.

The unexplained portable smoke failure recorded for 0.18.0 is separate: its original error was not captured, so its cause remains unknown. Current smoke checks preserve failure details.
