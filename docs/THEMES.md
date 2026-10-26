# Themes and terminal colors

KonX 0.29.0 adds five static themes to the existing classic and animated choices. A theme controls application colors; a [workspace layout](WORKSPACE_LAYOUTS.md) controls where panels are placed. You can combine any theme with Classic, Docked Workbench, Incident Desk, Operations Wall, or Focus Workspace.

## Choose an application theme

1. Open **Settings → Appearance**.
2. Choose **Application theme**.
3. Select a theme, then choose **Save**.

| New theme | Appearance | Terminal when following the application |
| --- | --- | --- |
| **Obsidian Gold** | Charcoal panels with warm gold accents | Dark with gold accents |
| **Arctic Glass** | Cool light panels with cobalt accents | Light with cobalt accents |
| **Deep Ocean** | Dark petrol panels with seafoam accents | Dark with seafoam accents |
| **Sandstone** | Warm paper panels with clay accents | Light with clay accents |
| **Crimson Circuit** | Plum-charcoal panels with rose-red accents | Dark with rose-red accents |

These five themes have no animated effects. They color the header, sidebar, tool panels, forms, menus, dialogs, and Notepad. Floating panels and pop-out windows use the same application theme. The updater remains at the top right of the header.

Your choice is retained after restarting KonX. Upgrading keeps your existing theme and layout; it does not select one of the new themes automatically. Changing appearance keeps open sessions, documents, and tool results in place.

## Match terminal colors

To match terminal output to the selected application theme, set **Settings → Appearance → Terminal color scheme → Follow application theme**, then choose **Save**. This is the default for new profiles.

Existing profiles retain their terminal scheme during an upgrade. A saved session's explicit **Terminal & Log → Color scheme** choice takes precedence over the global setting. If one session still uses an older palette, inspect its override and choose **Follow application theme** there to match the application.

You can also keep a separate terminal palette. **KonX Dark**, **Classic**, **Green Phosphor**, **Solarized Dark**, **Monokai**, and **Light** retain their established colors. For example, Sandstone can use a dark Solarized terminal while the surrounding tools and Notepad remain light.

Notepad follows the application theme independently of the terminal palette. Cisco terminal highlighting uses the terminal's actual background to keep recognized errors, interface states, and addresses readable. The theme does not alter terminal text, clipboard contents, saved logs, or remote command output. See [Cisco highlighting](CISCO_HIGHLIGHTING.md).

## Existing animated themes

**Arc Reactor**, **Chroma RGB**, **Matrix Mainframe**, **Synthwave Grid**, **Hologram Prism**, and **Plasma Forge** remain available, along with classic **Dark** and **Light**.

For an animated theme, use **Pause effects** / **Resume effects** in the header or **Animate theme effects** in Appearance. The motion preference is saved. Windows reduced-motion preferences are respected. Selecting a static theme does not change the saved motion preference for a later animated-theme selection.

## Test the five themes

After updating to 0.29.0:

1. Select each new theme in Appearance and save it. Check the header, sidebar, Settings, menus, and the **Update KonX** dialog.
2. Use **Follow application theme** in a terminal. Check normal text, selected text, IP addresses, and Cisco up/down or error output. Arctic Glass and Sandstone should use light terminal backgrounds.
3. Open a configuration in Notepad and inspect syntax colors, selection, search, and comparison views. Keep a copy of any file before editing it.
4. Open a sample capture and inspect packet rows, selected packet details, readable traffic, and SIP dialogs. Check KonX-AI and other tools you regularly use for readable text and controls.
5. Switch workspace layouts, resize KonX, float a panel, pop it out, and dock it back. Confirm that the chosen theme follows the panel and controls remain reachable.
6. Choose an explicit terminal palette for one saved session and confirm that changing the application theme keeps that override. Restart KonX and confirm the saved application theme, layout, and terminal preferences remain selected.

These are field-testing steps, not a statement that every device and display combination has been verified. Executed release checks and their limits are recorded in the [0.29.0 release notes](releases/0.29.0.md).

If text is difficult to read or a control is clipped, include the theme, workspace layout, Windows display scale, window size, and affected tool in your report. Use [Report a problem](TESTER_SUPPORT.md) to save diagnostics, and review screenshots for private information before sharing them.
