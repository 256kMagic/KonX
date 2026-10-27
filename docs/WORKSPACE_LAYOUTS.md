# Workspace layouts and windows

Available from KonX 0.14.0. Choose **Settings → Appearance → Workspace layout**, then **Save**. Layout controls the placement of sessions and tools; **Application theme** controls colors and motion. Terminal palettes remain separate, including saved per-session palettes.

The **Workspace layout** dropdown in the top toolbar is a shortcut. A choice there applies and saves immediately.

Existing profiles keep **Classic** until you choose another layout. **Cancel** discards a layout choice made in Settings. An unknown layout value falls back to Classic.

## Split screen shortcut

From **KonX 0.33.0**, use the controls above the tabs:

1. Select the console or tool you want to show and click **Split screen**. The same action is available from the tab's right-click menu.
2. KonX opens Workbench with your selected view and another existing view when available. A new split prefers another open console; an existing Workbench pair stays in place. It does not create or connect a new session. If there is no second view, open one and choose it from the empty pane's dropdown.
3. Use the pane dropdowns to select different open views. Drag the divider to change their relative sizes; narrow windows stack panes vertically. Click inside a console to make it the command target before typing.
4. Use **Single view** to return to the previous Classic or Focus arrangement when remembered, otherwise Classic. Both tabs remain open.

**Pop out** moves the active console or tool into a separate Windows window. Drag the native title bar to move it to another monitor or beside another application. **Dock back** returns it to KonX; the live connection is preserved. Existing right-click and pane-header actions remain available.

The chosen workspace layout and divider sizes are saved. Restarting does not reopen connections or child windows automatically. Splitting or docking a console does not reconnect it.

## Move, resize, and pop out panels

From **KonX 0.18.0**, right-click any open tab and choose **Float in workspace** or **Pop out to window**. Pane headers also provide **Float** and **Pop out** controls. These actions move the existing view: terminal connections, capture packets, editor models, and tool results stay with it.

- **Move inside KonX:** float the panel, then drag its title bar. Click inside a panel to bring it forward and make it the active command target.
- **Resize:** drag a floating panel's edge or corner. Use **Maximize** / **Restore**, or double-click its title bar. Bounds stay within the workspace when the main window gets smaller.
- **Dock:** click **Dock**, or right-click its tab and choose **Dock back**. Drag a tab onto an existing pane to place it there; drag tabs along the tab strip to reorder them.
- **Resize split panes:** drag the divider in Workbench, Incident Desk, or Operations Wall. The divider also supports arrow keys when focused. Smaller windows stack panes with a horizontal divider that you drag up or down.
- **Use another monitor:** choose **Pop out**, then move or resize the separate Windows window normally. **Dock back** returns it to the main workspace; **Float in KonX** returns it as a floating panel.
- **Close a pop-out window:** its Windows **X** docks the live panel back into KonX. **Close tab** closes the tab using its existing behavior. Notepad retains its unsaved session backups; closing an individual unsaved document still offers Save, Don't save, and Cancel.
- **Reset:** **Reset workspace** returns floating and popped-out panels to the main workspace and restores default split ratios and floating geometry. It does not close tabs or reconnect sessions.

All application themes apply to pop-outs. Menus and dialogs follow the window being used. The main application remains the owner of the work, so exiting KonX closes the workspace and its child windows after the normal connection and cleanup checks. Up to 16 native pop-outs can be open at once.

From 0.18.1, pop-outs recover into an available display work area when displays change. Minimized/maximized states are preserved, and console status follows its fitted size. Automated checks cover simulated 100%, 125%, 150%, and 200% scales; physical monitor changes still need tester coverage. Use [Report a problem](TESTER_SUPPORT.md) to save a reviewed diagnostic report.

Saved geometry contains split ratios and the last floating rectangle only. Restarting does not recreate pop-outs, restore live connections, or automatically rerun tools. A terminal selection can clear when resizing changes its rows or wraps text, following the terminal's normal resize behavior; its scrollback remains available.

From 0.19.0, [Saved Site Workspaces](SITE_WORKSPACES.md) can separately retain a named arrangement of supported panels and references. Opening a saved site restores passive panels; session connections and capture reads remain explicit actions.

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

Incident Desk uses the existing local incident workspace. A layout change does not assign evidence to an incident or share context with AI. Use **Add to incident** and review/save the pending evidence, or use **Ask KonX-AI** to choose evidence and review a request before sending it.

Open **Incident Workspace**, then select that open tab in the **Incident dossier** pane. Its existing saved-case list appears under **Case navigation**. Leaving Incident Desk returns that list to its original tool view.

The layout preference survives restart. Open connection and tool placement is session state, not a promise to reconnect or restore all tabs after restarting. Save captures, documents and reports that you need to keep. Normal close confirmations and updater blockers still apply in every layout.

## Window sizes and themes

All layouts use the selected application theme. KonX 0.30.0 adds **Ion Storm**, **Solar Flare**, **Aurora Flux**, **Hyperdrive**, and **Ghost Circuit**, bringing the animated choices to 11. The five static palettes introduced in 0.29.0 and classic Dark/Light remain available. The same theme applies to floating panels and native pop-outs. Header pause/resume, **Animate theme effects**, and Windows reduced motion control animation while retaining the selected colors and decorative background. See [Themes and terminal colors](THEMES.md).

Smaller windows stack the panes in a scrollable workspace; expand a pane when its tool needs more room. Context opens as a collapsible overlay in small Workbench and Focus windows. Tab overflow controls keep all open tabs reachable.

The release notes describe executed validation and remaining coverage. Real network equipment and production workflows require field testing.

## Home sections

Home visibility choices apply to every workspace layout. Close any Home section with the small × inside its panel's top-right corner, then use **Customize Home** to show it again or restore all sections. Hiding a Home group changes only the landing page; saved sessions, tool access, and open work remain available. See [Customize Home](USER_GUIDE.md#customize-home).
