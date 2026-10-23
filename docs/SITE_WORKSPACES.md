# Saved Site Workspaces

Available from KonX 0.19.0. Open **Saved Site Workspaces** from Home or Network Tools to keep a site's session references, layout, notes, capture references, and incident links together.

## Create and save a site

1. Choose **New** and enter a recognizable name, or **Save current workspace** to start from your current panels.
2. Add existing saved sessions and assign group labels, such as Core, Access, or Voice. The workspace refers to those saved sessions; it does not copy their passwords, private keys, or connection specifications.
3. Add notes and references to capture files and saved incidents. Capture references point to files on this computer; they do not embed packet bytes.
4. Arrange your panels and choose **Capture current panels** to record their placement. Terminal and SFTP panel types are retained separately.
5. Choose **Save**. Changes are local to the current KonX profile.

## Reopen and work

Select a site, then choose **Open workspace** to restore its working context without connecting to devices or starting collection. Review the session references, then choose **Connect**. Replace a missing session by removing that reference and adding the correct saved session; names alone do not establish identity.

Capture and incident references open only when requested. A moved or deleted capture is reported as unavailable; select its new location. Existing live work remains open when restoring a site. Saved pop-outs return as floating panels so restored windows stay visible without opening extra native windows.

## Duplicate and share

Duplicate creates a separate workspace record. Export creates a JSON document that can be imported into another KonX profile. Import creates a new record and never overwrites an existing site or starts a connection.

Review notes, display names, paths, and incident references before sharing. Structured session credentials and executable connection specifications are excluded, but text you type can contain sensitive information. Session IDs, capture paths, and incident IDs may not exist on the receiving computer; map or replace those references there.

Deleting a site removes its workspace record. Saved sessions, captures, and incidents remain owned by their respective tools.

The library keeps up to 100 workspaces, with at most 128 session references, 64 capture references, 64 incident links, 32 panels, and 128 KiB of notes in each. Unsupported views and unsaved connection specifications are omitted when capturing panels, with an explanation. A revision check prevents another editor from silently overwriting newer saved changes. Failed saves and cancelled dialogs retain the draft; save or discard unsaved definitions before updating or closing their tab.

## Validation limits

Automated tests use isolated profiles, synthetic records, and owned loopback connections. They do not validate connectivity to real equipment or move the installed user profile. See the release notes for the executed checks and known limits.
