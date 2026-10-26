# Themes and terminal colors

KonX 0.30.0 adds five animated themes with distinct motion and glow. There are 18 application themes in total: 11 animated themes, five static palettes, and classic Dark and Light. A theme controls application colors and decorative effects; a [workspace layout](WORKSPACE_LAYOUTS.md) controls where panels are placed. You can combine any theme with Classic, Docked Workbench, Incident Desk, Operations Wall, or Focus Workspace.

## Choose an application theme

1. Open **Settings → Appearance**.
2. Choose **Application theme**.
3. Select a theme, then choose **Save**.

| New animated theme | Colors and motion |
| --- | --- |
| **Ion Storm** | Violet and ice blue with branching electrical arcs and traveling points of light |
| **Solar Flare** | Amber and copper with a glowing solar corona and slowly moving flares |
| **Aurora Flux** | Mint and violet with flowing aurora curtains |
| **Hyperdrive** | Ice blue and indigo with a moving starfield |
| **Ghost Circuit** | Mint and amber with pulses traveling along circuit traces |

The new themes coordinate the header, sidebar, tool panels, forms, menus, dialogs, terminals, and Notepad. Decorative backgrounds appear behind terminal and editor output; data tables and explanations use quieter surfaces. Floating panels and pop-out windows follow the selected application theme. The updater remains at the top right of the header.

Your choice is retained after restarting KonX. Upgrading keeps your existing theme and layout; it does not select one of the new themes automatically. Changing appearance keeps open sessions, documents, and tool results in place.

## Pause or resume motion

For any animated theme, use **Pause effects** / **Resume effects** in the header or **Animate theme effects** in **Settings → Appearance**. The motion preference is saved. Pausing keeps the theme's colors and decorative background visible without movement.

KonX respects Windows reduced-motion preferences. While reduced motion is active, theme effects stay still and the header motion button is disabled. Selecting a static theme does not change the saved motion preference for a later animated-theme selection.

## Match terminal colors

To match terminal output to the selected application theme, set **Settings → Appearance → Terminal color scheme → Follow application theme**, then choose **Save**. This is the default for new profiles. With an animated application theme, this also enables the decorative terminal background.

Existing profiles retain their terminal scheme during an upgrade. A saved session's explicit **Terminal & Log → Color scheme** choice takes precedence over the global setting. If one session still uses an older palette, inspect its override and choose **Follow application theme** there to match the application.

You can also keep a separate terminal palette. **KonX Dark**, **Classic**, **Green Phosphor**, **Solarized Dark**, **Monokai**, and **Light** retain their established colors and opaque backgrounds. For example, Solar Flare can use a Solarized terminal while surrounding tools and Notepad retain the Solar Flare appearance.

Notepad follows the application theme independently of the terminal palette. Cisco terminal highlighting uses the terminal's actual background to keep recognized errors, interface states, and addresses readable. The theme does not alter terminal text, clipboard contents, saved logs, or remote command output. See [Cisco highlighting](CISCO_HIGHLIGHTING.md).

## Earlier themes

The six earlier animated themes remain available: **Arc Reactor**, **Chroma RGB**, **Matrix Mainframe**, **Synthwave Grid**, **Hologram Prism**, and **Plasma Forge**. They use the same pause/resume and reduced-motion controls.

The five static themes introduced in 0.29.0 remain available alongside classic **Dark** and **Light**:

| Static theme | Appearance | Terminal when following the application |
| --- | --- | --- |
| **Obsidian Gold** | Charcoal panels with warm gold accents | Dark with gold accents |
| **Arctic Glass** | Cool light panels with cobalt accents | Light with cobalt accents |
| **Deep Ocean** | Dark petrol panels with seafoam accents | Dark with seafoam accents |
| **Sandstone** | Warm paper panels with clay accents | Light with clay accents |
| **Crimson Circuit** | Plum-charcoal panels with rose-red accents | Dark with rose-red accents |

Static themes have no moving effects and do not need pausing.

## Test the five animated themes

After updating to 0.30.0:

1. Select each new theme in Appearance and save it. Check its distinctive effect, header glow, sidebar, Settings, menus, and the **Update KonX** dialog.
2. Use **Follow application theme** in a terminal. Check normal text, selected text, IP addresses, and Cisco up/down or error output while the background moves.
3. Use **Pause effects**, then **Resume effects**. Confirm motion stops and resumes while text remains readable. Try Windows reduced motion and confirm the effects stay still.
4. Open a configuration in Notepad and inspect syntax colors, selection, search, and comparison views. Keep a copy of any file before editing it.
5. Open a sample capture and inspect packet rows, selected packet details, readable traffic, and SIP dialogs. Check KonX-AI and other tools you regularly use for readable text and controls.
6. Switch workspace layouts, resize KonX, float a panel, pop it out, and dock it back. Confirm that the chosen theme follows the panel and controls remain reachable.
7. Choose an explicit terminal palette for one saved session and confirm that changing the application theme keeps that override. Switch to a static theme and back, then restart KonX. Confirm the application theme, layout, terminal palettes, and motion preference remain selected.

These are field-testing steps, not a statement that every device and display combination has been verified. Executed release checks and their limits are recorded in the [0.30.0 release notes](releases/0.30.0.md).

If text is difficult to read, motion does not stop, or a control is clipped, include the theme, workspace layout, Windows display scale, window size, and affected tool in your report. Use [Report a problem](TESTER_SUPPORT.md) to save diagnostics, and review screenshots for private information before sharing them.
