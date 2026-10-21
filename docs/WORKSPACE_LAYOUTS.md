# Workspace layouts

Available from KonX 0.14.0. Choose **Settings → Appearance → Workspace layout**, then **Save**. Layout controls the placement of sessions and tools; **Application theme** controls colors and motion. Terminal palettes remain separate, including saved per-session palettes.

The **Workspace layout** dropdown in the top toolbar is a shortcut. A choice there applies and saves immediately.

Existing profiles keep **Classic** until you choose another layout. **Cancel** discards a layout choice made in Settings. An unknown layout value falls back to Classic.

## Choose a workspace

| Layout | Structure | Useful for |
| --- | --- | --- |
| Classic | Session sidebar, one active tool and the familiar top tab strip | Keeping the original workspace |
| Docked Workbench | Active tool with a chosen companion pane and context | Working between a terminal and an investigation |
| Incident Desk | Case navigation and an incident dossier alongside the selected tool | Reviewing retained evidence and writing up a case |
| Operations Wall | Up to four open views, each with focus and expand controls | Watching several sessions or results at once |
| Focus Workspace | One large working view with the tab switcher below it | Packet tables, editing and concentrated terminal work |

## Keep control of open work

Switching layout rearranges the existing tab instances. It does not reconnect sessions, rerun tools, clear captures, save pending evidence, or start collection. Open tabs remain available even when they are outside the visible pane slots. Hiding a pane is different from closing its tab.

The focused pane is the active command target. Select a pane before using terminal commands, keyboard shortcuts, or the programmable button bar. The command window's **Send to all terminal tabs** and the button bar's Ctrl+click broadcast remain explicit actions.

Use the pane selectors to choose from existing open tabs. Focus moves the input target; expand temporarily gives a pane more space. Tool-specific actions remain inside their owning view. SIP and RTP dialogs continue to open through Packet Capture.

In Operations Wall, use the pane-count dropdown to show one to four views. Reducing the count hides the extra panes without closing their tabs. **Restore panes** returns from an expanded view. Workbench and Focus also offer **Show context** / **Hide context**; all four new layouts offer a sessions-sidebar toggle.

Focus initially hides Sessions and Context to give the tool more room. Use **Show sessions** or **Show context** when needed. Leaving Focus restores the sidebar visibility you had before entering it.

Incident Desk uses the existing local incident workspace. A layout change does not assign evidence to an incident or share context with AI. Use **Add to incident** and review/save the pending evidence, or preview context through **Explain with AI**.

Open **Incident Workspace**, then select that open tab in the **Incident dossier** pane. Its existing saved-case list appears under **Case navigation**. Leaving Incident Desk returns that list to its original tool view.

The layout preference survives restart. Open connection and tool placement is session state, not a promise to reconnect or restore all tabs after restarting. Save captures, documents and reports that you need to keep. Normal close confirmations and updater blockers still apply in every layout.

## Window sizes and themes

All layouts use the selected application theme, including the six animated themes and classic Dark/Light. Reduced-motion and pause settings remain in effect. Smaller windows stack the panes in a scrollable workspace; expand a pane when its tool needs more room. Context opens as a collapsible overlay in small Workbench and Focus windows. Tab overflow controls keep all open tabs reachable.

The release notes describe executed validation and remaining coverage. Real network equipment and production workflows require field testing.
