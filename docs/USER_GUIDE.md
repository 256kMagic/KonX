# KonX User Guide

This guide covers KonX 0.1.2 for Windows x64. KonX combines terminal sessions, SFTP, a text editor, packet capture, and network troubleshooting tools in one window.

For downloads, build instructions, and project information, see the [README](../README.md) and [GitHub releases](https://github.com/256kMagic/KonX/releases).

## Contents

- [Install, run, and update](#install-run-and-update)
- [Your first SSH connection](#your-first-ssh-connection)
- [Workspace and tabs](#workspace-and-tabs)
- [Saved sessions, folders, and imports](#saved-sessions-folders-and-imports)
- [Connection reference](#connection-reference)
- [Terminal workflow](#terminal-workflow)
- [SFTP file transfer](#sftp-file-transfer)
- [KonX Notepad](#konx-notepad)
- [Packet capture and analysis](#packet-capture-and-analysis)
- [Network tools](#network-tools)
- [Settings](#settings)
- [Keyboard reference](#keyboard-reference)
- [Application data and backups](#application-data-and-backups)
- [Troubleshooting](#troubleshooting)
- [Reporting a problem](#reporting-a-problem)

Examples use reserved documentation addresses such as `192.0.2.10`, `198.51.100.20`, and `2001:db8::10`, plus the example domain `example.com`. Replace them with your own authorized hosts. A `localhost` example works only when the corresponding service is running on your computer.

## Install, run, and update

Download a Windows x64 executable from [GitHub releases](https://github.com/256kMagic/KonX/releases).

| Download | Use it when | How to start |
| --- | --- | --- |
| `KonX-Setup-0.1.2.exe` | You want an installed application with shortcuts | Run setup, choose an installation folder, finish, and open KonX |
| `KonX-0.1.2-portable.exe` | You want to run the application without its normal installer | Put the executable in a suitable folder and run it |

The portable executable still uses a Windows user profile for settings, saved sessions, and editor recovery. It does **not** automatically place all data beside the executable or make encrypted credentials transferable between computers. See [Application data and backups](#application-data-and-backups).

For an update:

1. Save local and remote files, finish or cancel transfers, and save any packet captures you want to keep.
2. Close KonX. If it reports active connections, choose **Disconnect and quit** when ready.
3. Run the newer setup, or replace your portable executable with the newer portable download.
4. Reopen KonX. The same Windows account normally continues to use its existing profile.

There is no in-app automatic updater in this version. Npcap is optional for packet capture; SSH, SFTP, Notepad, and the other tools do not require it. Interactive setup includes a **Packet capture** page that can offer to download and open Npcap's separate installer. That option is unchecked by default and is skipped during silent installation; you can install Npcap later from KonX or its official website.

## Your first SSH connection

### Connect once

1. On **Home**, leave **Protocol** set to **SSH2**.
2. Enter your server under **Host**, for example `192.0.2.10`.
3. Set **Port** to the server's SSH port, usually `22`.
4. Enter **Username**, or let KonX ask when connecting.
5. Click **Connect**.
6. Verify the SSH host fingerprint before accepting it.
7. Answer the password, key passphrase, or keyboard-interactive prompts presented by the server.

The toolbar's quick-connect field is another way to connect. Press **Alt+Q**, enter `operator@192.0.2.10:22`, and press **Enter**. This opens a connection without creating a saved session.

### Verify the server identity

For an unknown server, **New host key** shows the key type and SHA-256 fingerprint. Compare it with a fingerprint supplied through a trusted channel by the server administrator.

| Choice | Result |
| --- | --- |
| **Cancel** | Reject the connection |
| **Accept once** | Continue this connection without storing the fingerprint |
| **Accept & save** | Store the fingerprint for this host and port and continue |

If the fingerprint differs from one already saved, KonX shows **Host key changed** with both fingerprints. Establish why it changed before using **Replace & connect**. A reinstalled server is one possible cause; an intercepted connection is another.

Saved keys are managed under **Settings → Known Hosts**. Removing a key makes KonX ask again on the next connection; removal does not verify the replacement key.

### Save a session

1. Click **+** beside **Sessions**, or choose **New session** on Home.
2. In **General**, set **Name**, **Protocol**, **Hostname or IP**, **Port**, and **Username**.
3. In **Authentication**, choose the appropriate method:
   - **Password / keyboard-interactive** for passwords and server challenge prompts.
   - **Public key file** for a private-key file and optional passphrase.
   - **SSH agent (Pageant / OpenSSH)** for an available SSH agent. The default Windows connection is the OpenSSH agent pipe; an existing `SSH_AUTH_SOCK` takes precedence.
4. Use **Save** to keep the session, or **Save & Connect** to start it.

Saved passwords and passphrases use Electron's Windows-backed encryption when available. If the dialog says encryption is unavailable, KonX does not persist a newly supplied secret. Leaving an existing saved password field blank keeps its current value; clear **Save password** to remove it.

Double-click the saved session to connect again. Right-click it for **Edit…**, **Duplicate**, **Connect SFTP**, and related tools. Duplicating a session does not duplicate its saved password or passphrase.

![KonX terminal workspace](screenshots/terminal.png)

## Workspace and tabs

- The left sidebar contains saved **Sessions** and **Network Tools**. The toolbar's session-manager button shows or hides it; drag its edge to resize it.
- The top toolbar opens **SFTP**, **Notepad**, the tools menu, **Home**, **Settings**, the button bar, and the command window. Hover over an icon for its label.
- Each terminal, SFTP connection, capture, or network tool has an application tab. Notepad has one application tab with its own document tabs inside it.
- Right-click an application tab to rename it, close it, close others, or close all. Terminal tabs also offer cloning, reconnecting, disconnecting, and opening SFTP when available.
- Drag application tabs to rearrange them. **Alt+1** through **Alt+9** selects a tab by position.
- The status bar describes the active view, including connection state and active transfers.

### Disconnect versus close

**Disconnect** ends a terminal connection but keeps its tab and scrollback. Use the tab menu's **Reconnect**, the terminal's reconnect control, or press **Enter** in a disconnected terminal to reconnect.

Clicking a connection tab's **X**, **Ctrl+Shift+W**, or **Ctrl+F4** removes the application tab and closes its terminal connection. It does not delete the saved session in the sidebar. The X hit area was corrected in version 0.1.2.

Closing an SFTP tab cancels its remaining transfers; KonX asks before closing when transfers are active. Closing a capture or running tool stops that work. Save capture packets before closing the capture tab: they are held in memory.

Closing the **Notepad application tab** retains its editor session and recovery copies for reopening. Closing an individual **document tab** asks how to handle unsaved changes. These are different actions.

## Saved sessions, folders, and imports

### Organize sessions

Use **New folder** beside Sessions to create a folder. A folder's right-click menu supports a new session, subfolder, rename, delete, and **Connect all**. **Connect all** connects sessions directly in that folder; it does not recurse through subfolders.

Drag a session onto a folder to move it. Its **General → Folder** field can also place it at a path such as `Lab/Routers`, or at the top level when empty. Renaming a folder also updates its descendants. Deleting a folder removes the folder hierarchy and moves its sessions to the deleted folder's parent; it does not delete those sessions.

**Filter sessions** matches names, hosts, usernames, folder paths, and serial-port names. Press **Enter** in the filter to connect the first match; **Esc** clears the filter. In the tree, select a session and press **Enter** to connect, **F2** to edit, or **Delete** to delete its saved definition.

### Import from SecureCRT

Choose the import button or **Import from SecureCRT** on Home, then select the SecureCRT **Sessions** directory. KonX reads supported `.ini` files recursively and puts them under a **SecureCRT** folder, preserving the source folder layout.

Supported session information includes SSH, Telnet, Raw TCP, or Serial protocol; host; username; port; selected serial parameters; and certain explicit SSH identity-file settings. SecureCRT's saved passwords, encrypted secrets, and full application configuration are not imported. Review authentication, serial flow control, jump hosts, forwarding, logging, and logon actions after import.

### Import from OpenSSH config

Choose **Import ~/.ssh/config**, then select the desired config file. Imported sessions appear under **SSH config**. The importer reads `Host`, `HostName`, `User`, `Port`, `IdentityFile`, and a limited `ProxyJump` mapping.

This importer is not a full OpenSSH configuration evaluator:

- It creates the first concrete alias from each `Host` block and skips aliases containing `*`, `?`, or `!`.
- It does not apply wildcard-block inheritance, `Include`, `Match`, `ProxyCommand`, or other OpenSSH directives.
- It considers the first comma-separated `ProxyJump` entry and links it only when the alias matches another imported session.
- Repeating an import creates additional session entries; it does not merge them with earlier imports.

Review imported sessions before connecting, especially non-default ports, identity-file paths, and jump hosts.

## Connection reference

### Quick-connect examples

| Input | Connection |
| --- | --- |
| `operator@192.0.2.10:2222` | SSH on port 2222 |
| `ssh://operator@192.0.2.10` | SSH on port 22 |
| `ssh://operator@[2001:db8::10]:2222` | SSH to a bracketed IPv6 address |
| `telnet://192.0.2.10:23` | Telnet |
| `raw://127.0.0.1:9000` | Raw TCP to a local test service |
| `sftp://operator@192.0.2.10:22` | SFTP using password authentication |
| `COM3` | Serial with the quick-connect default of 9600 baud |

Use a saved session for key authentication, agent authentication, detailed serial settings, a jump host, logon actions, forwarding, or automatic logging. For quick serial connections, the Home form lets you select **Serial**, enter the COM port, and use its **Port** field for baud rate.

### SSH connection options

**Connection** contains **Jump host (ProxyJump)**, **Keepalive (seconds)**, **Connect timeout (seconds)**, and **Terminal type**. The default terminal type is `xterm-256color`; other options include `xterm`, `vt100`, `vt220`, `linux`, and `ansi`.

A jump host must be another saved SSH session. Save the jump session first, then select it in the destination session. KonX authenticates each hop and verifies each server's host key. It supports a bounded chain of jump hosts and rejects excessive nesting; avoid circular references.

### SSH port forwarding

In **Port Forwarding**, click **Add port forward** and select a type. Forwards start with the SSH terminal connection and stop when it closes. Check the terminal's status messages for bind failures or server rejections.

| Type | Listen endpoint | Destination is reached from |
| --- | --- | --- |
| **Local (-L)** | Your computer | The SSH server |
| **Remote (-R)** | The SSH server | Your computer |
| **Dynamic SOCKS (-D)** | Your computer | The SSH server, using a SOCKS5 client's requested destination |

For a local tunnel, an example row is **Local (-L)**, listen host `127.0.0.1`, listen port `8443`, destination host `198.51.100.20`, destination port `443`. A local application then connects to `127.0.0.1:8443`; the SSH server must be able to reach the destination.

For a dynamic proxy, set a local listen host and port and configure the client application to use SOCKS5 at that endpoint. KonX's SOCKS5 implementation supports CONNECT without proxy authentication. Binding to `127.0.0.1` keeps it local; use a broader listen address only when you intend other computers to reach it. Remote forwarding also depends on the SSH server's forwarding policy.

### Telnet and Raw TCP

Choose **Telnet** or **Raw TCP** under **General → Protocol** and set the host and actual service port. Both quick-connect defaults are port 23; Raw TCP does not infer a protocol-specific port.

Telnet negotiates Telnet terminal options. A saved username and password can answer recognized initial login prompts automatically. **Logon Actions** can handle additional text prompts. Raw TCP sends and receives a plain TCP stream without Telnet negotiation.

Telnet and Raw TCP do not provide SSH's encryption or server identity verification. Use them only where the connection's security properties are appropriate.

### Serial consoles

Choose **Serial**, select or type the COM port, and use the refresh control to list ports. Match the attached device's documented settings:

- Baud: 1200 through 921600 from the provided list; default 9600.
- Data bits: 5, 6, 7, or 8; default 8.
- Parity: None, Even, Odd, Mark, or Space.
- Stop bits: 1 or 2.
- Flow control: None, RTS/CTS, or XON/XOFF.

The serial library is an optional build dependency. If KonX reports **Serial support is not available in this build**, use a build that includes it. Another program holding the COM port can also prevent a connection.

### Logon actions

Each **Logon Actions** row waits for literal text, then sends its reply followed by Enter. Rows run in order after the connection opens. The reply supports `{username}`, `{password}`, and escapes such as `\r` and `\t`. A blank wait field sends after a short delay. A step waiting for unmatched text times out after 30 seconds and stops the sequence.

Use a distinctive prompt fragment and test the sequence on a non-critical session. Do not append `\r` merely to add Enter: the action already appends it. Prefer the `{password}` placeholder to placing a literal password in a logon-action string, since action strings are ordinary session configuration.

## Terminal workflow

### Copy, paste, search, and links

Select text to copy automatically when **Copy on select** is enabled. **Ctrl+Shift+C** or **Ctrl+Insert** copies explicitly. Paste with **Ctrl+Shift+V**, **Shift+Insert**, or middle-click. Right-click normally opens a menu; **Settings → Terminal** can change it to paste.

With **Confirm before pasting multiple lines** enabled, KonX previews a multi-line paste and asks before sending it. A pasted newline can execute a command on the remote device, so check the target terminal and text before accepting.

Use **Ctrl+Shift+F** for terminal scrollback search. **Enter** finds the next match, **Shift+Enter** the previous one, and **Esc** closes the search bar. **Shift+Page Up/Down** scrolls the terminal history. **Ctrl+=**, **Ctrl+-**, and **Ctrl+0** adjust or reset terminal zoom. **Ctrl+click** a detected web link to open it in the default browser.

The context menu also offers **Select All**, **Clear Scrollback**, **Open scrollback in Notepad**, and **Send Break** for Telnet or Serial. Opening scrollback in Notepad creates an editable copy; save it to retain it as a file.

### Session logging

Right-click a connected terminal and choose **Start Logging** or **Stop Logging**. To start automatically for a saved session, enable **Terminal & Log → Log this session automatically** and optionally choose a filename template and **Timestamp each line**.

The default log folder is `Documents\KonX\Logs`, unless **Settings → Terminal → Default log folder** overrides it. Logs are appended as text with terminal control sequences stripped.

| Filename token | Value |
| --- | --- |
| `%S` | Session name |
| `%H` | Host |
| `%Y`, `%M`, `%D` | Year, month, day |
| `%h`, `%m`, `%s` | Hour, minute, second |

For example, `%S_%Y-%M-%D_%h%m%s.log` makes a timestamped session filename. Terminal logs may contain configuration, command output, or other sensitive text displayed by the server.

### Command buttons and sending to several terminals

Use the toolbar's **Button bar** control to show reusable command buttons. Right-click a button to edit, move, or delete it; **+** creates a button. The **Send** value supports `\r` for Enter, `\n` for newline, `\t` for tab, `\e` for Escape, and `\x03` for Ctrl+C. A button that should execute a command usually ends in `\r`.

A normal click sends to the active terminal. **Ctrl+click** sends to every connected terminal tab.

The **Command window** accepts a line and sends it followed by Enter. Enable **Send to all terminal tabs** to broadcast it to every connected terminal; clear the checkbox to send to the active terminal only. **Up/Down** recalls command-window history. Confirm the intended recipients before using either broadcast feature.

## SFTP file transfer

### Connect

- From a connected SSH terminal, click **SFTP** or choose **Open SFTP tab** in its tab menu. This shares the SSH transport: disconnecting or closing that terminal also ends this SFTP connection.
- Right-click a saved SSH session and choose **Connect SFTP** to open a separate SFTP connection.
- With no applicable terminal or saved session selected, the toolbar's **SFTP** button asks for `user@host:port`.

The server must offer the SFTP subsystem. SSH authentication, host-key checks, and saved jump-host configuration apply to separate SFTP connections as well.

### Navigate and transfer

The left pane is **Local** and the right pane is **Remote**. Enter a path in a pane's address field, double-click a folder, or use **Up**, **Home**, and **Refresh**. The eye control toggles hidden files.

To transfer, select files or folders and use the upload/download button or context menu. You can also drag between the local and remote panes in the same SFTP tab. Dropping Windows Explorer files onto the remote pane uploads them; dropping onto a remote folder targets that folder.

**Double-clicking a file transfers it to the opposite pane.** To edit it, use its right-click menu instead.

The **Transfers** panel shows each queued file's destination, progress, speed, and status. Right-click queued or running jobs to **Cancel**. **Clear finished** removes completed entries from the display. Failed or canceled ordinary transfers are not automatically re-queued; select the source and start the transfer again.

| Conflict policy | Behavior |
| --- | --- |
| **Ask** | Show source and existing destination information, then choose Skip or Overwrite |
| **Overwrite** | Replace the existing destination file |
| **Skip** | Keep the existing destination file |
| **Overwrite if newer** | Compare modification times and replace when the source is newer |

An Ask dialog can apply your decision to the remaining files in that transfer. The policy is available in the transfer panel and **Settings → File Transfer**. That settings page also controls the initial local folder, hidden files, and 1–8 simultaneous transfers; the default is 2.

Right-click files to rename or copy paths, and remote files to change permissions. Local deletion uses the Recycle Bin. Remote deletion is permanent, including the contents of selected folders. KonX rejects remote names that cannot be downloaded safely as local filenames; resolve such a name on the server before retrying.

![SFTP panes and transfer queue](screenshots/sftp.png)

### Edit a remote file

**Edit in KonX Notepad** reads the file into the built-in editor. **Ctrl+S** writes directly back to that remote path. Keep the SFTP tab connected until the save completes. Use **Save As…** for a local copy; this changes that document's destination to the selected local file. Remote files opened this way are limited to 50 MB.

**Edit with default app** downloads a temporary local copy and opens it in Windows' associated application. While the SFTP session remains open, KonX watches the temporary copy and uploads changes after you save. A failed upload shows an error with the local copy's path and retries with increasing delays, up to 30 seconds between attempts.

Wait for **Uploaded …** before relying on a remote edit. Closing its SFTP tab stops the default-app watcher and automatic retries. If the transport is lost, preserve the temporary file, reconnect, and upload it explicitly. This workflow does not merge edits made independently on the server.

## KonX Notepad

Click **Notepad** in the toolbar. It opens a Monaco-based editor with a menu bar, internal document tabs, a document map, and a status bar. Use **File → Open…** for one or more local files, drag files into the editor, or open a local/remote file from SFTP. Local files larger than 200 MB are rejected; large files below that limit may still use substantial memory.

### Save and recover documents

The dot on a document tab marks unsaved changes. **Ctrl+S** saves, **Ctrl+Alt+S** saves under another local filename, and **Ctrl+Shift+S** saves all dirty documents. Edits made while a save is finishing remain marked unsaved until those newer edits are saved too.

Close a document with its own X or **Ctrl+W** to choose **Save**, **Don't save**, or **Cancel** when needed. **Ctrl+Shift+T** reopens the last closed local file.

KonX records the editor session and periodic recovery copies of unsaved text. Reopening Notepad restores available documents and unsaved text. Closing the whole Notepad application tab retains that session rather than prompting for every document. Recovery is a convenience, not a substitute for deliberate saves or backups.

After restart, recovered unsaved remote text becomes an **unsaved copy**. It is not silently reattached to a server. Save it locally, or reconnect SFTP and deliberately apply the text to the intended remote file.

If a local file changes outside KonX, a clean document reloads automatically. A document with unsaved changes asks before reloading. If the file was moved or deleted, KonX reports it and marks the document unsaved so you can recreate it or save elsewhere.

### Encoding, line endings, and languages

The **Encoding** menu supports UTF-8, UTF-8 with BOM, UTF-16 LE/BE with BOM, and ANSI (Windows-1252). BOMs are recognized on open; otherwise valid UTF-8 is used, with Windows-1252 as a fallback. A file that appears binary opens read-only.

**Encode in …** selects the format for the next save. **Reopen as …** reads a local file from disk with the selected decoder, replacing the editor's current text. Save or copy unsaved work before using Reopen. Saving unrepresentable characters as ANSI prompts because they would become `?`; choose UTF-8 to keep them.

Choose **Windows (CR LF)**, **Unix (LF)**, or **Macintosh (CR)** line endings from the Encoding menu or status bar, then save to apply the change. The **Language** menu includes network-config, log, JSON, YAML, shell, and other syntax modes. Changing language controls editing/highlighting; it does not validate a device configuration.

### Editing and searching

- **Edit** provides duplicate/delete/move/join lines, sort alphabetically or by IPv4 address, remove duplicate/empty lines, reverse lines, trim whitespace, convert tabs/spaces, case changes, comments, and read-only mode. Text transforms use the selection when present or the whole document otherwise.
- **Search** provides Find, Replace, next/previous match, selection of occurrences, Go to line, matching brackets, and the editor command palette.
- **View** controls word wrap, whitespace, the document map, folding, and zoom.
- **Search → Find in Files…** searches a chosen local directory with filename wildcards, optional subfolders, match case, whole word, or regular expressions. Click a result to open its file at the matching line. It skips certain system/dependency folders, files over 20 MB, and apparent binary files, and stops at 5,000 matching lines by default. A result represents the first match on a line.

For example, search for `interface` with Filters `*.cfg *.conf *.txt` in a directory of exported configurations. Use **Stop** to end a search and the result panel's X to hide it.

### Compare documents

Open both files, then choose **View → Compare with…**, the compare toolbar button, or a document tab's comparison menu. Choose the other document to show a diff. **Previous** and **Next** move between differences; use **Inline view** or **Side by side** to change the layout. **Close compare** returns to normal editing.

![Notepad document comparison](screenshots/notepad-compare.png)

### Text utilities and file hashes

The Notepad **Tools** menu offers:

- JSON formatting/minifying and XML/HTML formatting.
- Base64, URL, and hexadecimal encoding/decoding.
- MD5, SHA-1, SHA-256, and SHA-512 hashes for selected/all text or a file.
- Extracted IPv4 or MAC addresses in a new document.
- **Copy config without secrets**, which creates a sanitized copy using recognizable configuration patterns.
- Line, word, character, and UTF-8 size statistics.

For **Verify a file hash (firmware)…**, choose the file and paste the expected hash. Compare with a hash obtained from a trusted source for that exact file/version. The utility's match result compares bytes; it does not establish who published the file. Review a sanitized document yourself before sharing because patterns cannot identify every possible secret.

### Send text to a terminal

1. Connect the intended terminal first.
2. Open or paste the text into Notepad and optionally select the lines to send.
3. Choose **Tools → Send to terminal…** or its toolbar button.
4. Choose the destination and **Selected lines** or **Whole document**.
5. Adjust **Delay between lines (ms)**; the default is 150 ms. Slow serial devices may need longer.
6. Decide whether to **Skip blank lines and "!" comments** and switch to the terminal.
7. Click **Send**.

Each line is sent followed by Enter. The feature sends commands; it does not wait for command success or parse device prompts. Return to Notepad for the sending status and **Stop** control. Sending stops if the target disconnects.

## Packet capture and analysis

Open **Packet Capture** from the sidebar, tools menu, or Home. You can inspect files without starting live capture. Only capture traffic where you have authorization, and treat packet files as potentially sensitive.

![Packet capture, decoded fields, and insights](screenshots/capture.png)

### Choose a capture engine

| Engine | Requirements and behavior |
| --- | --- |
| **Windows built-in capture** | Uses Windows' NDIS capture driver when available. Starting a capture asks for administrator permission through a helper unless KonX is already elevated. No additional packet driver is required. |
| **Npcap** | Optional separately installed driver. Adds a loopback interface and BPF capture filters. Capture permissions depend on the Npcap installation's settings. |

When Npcap is available it is preferred; the interface selector can also list built-in adapters. Pick the group and adapter you intend to use. Built-in **All adapters** is useful when you are unsure which adapter carries the traffic, but may include more traffic and duplicate observations.

If **Install Npcap** is offered, KonX downloads the official installer and checks its digital signature before opening Npcap's own setup. Follow that setup and its license. Npcap has separate licensing and redistribution terms; consult the current [official Npcap site](https://npcap.com/) for your intended use. Alternatively, install it from the official site and retry detection or reopen KonX.

The built-in engine does not provide Npcap-style loopback capture. For traffic between applications on the same machine through loopback, select an appropriate Npcap loopback interface after installing Npcap.

### Start and stop a live capture

1. Select the adapter carrying the traffic.
2. Optionally enter a **Capture filter** before starting.
3. Click **Start** and approve Windows' administrator prompt when using the built-in helper.
4. Reproduce the network activity.
5. Click **Stop**, inspect the packets, and save the capture.

Starting a new capture clears the previous packet list. Save any earlier capture first. Live capture automatically stops at one million retained packets; save it and start a new capture for another interval. The packet count, displayed count, rate chart, and drop statistics help assess what was collected. High traffic rates and large captures can use substantial memory.

### Capture filters versus display filters

A **capture filter** decides what is retained during a live capture. Packets it excludes cannot be recovered later. A **display filter** changes which retained packets are shown and can be changed repeatedly without deleting the other retained packets.

- For **Npcap**, the capture-filter field uses **BPF** syntax, applied by the driver.
- For **Windows built-in capture**, it uses the **KonX display-filter language**, applied as packets arrive; non-matches are not retained by the view.
- The display-filter row always uses KonX's language. It has Wireshark-like fields and shorthand, but is not a complete Wireshark filter implementation.

Example KonX display filters:

| Filter | Shows |
| --- | --- |
| `host 192.0.2.10` | Packets involving that address |
| `src host 192.0.2.10` | Packets from that address |
| `net 192.0.2.0/24 and not port 22` | IPv4 subnet traffic except port 22 |
| `tcp port 443` | TCP traffic involving port 443 |
| `port 8000-8100` | Traffic in that port range |
| `dns or mdns or llmnr` | Name-resolution traffic |
| `tcp.analysis.flags or rst` | Annotated TCP issues or resets |
| `http.host contains "example"` | Decoded HTTP host values containing the text |
| `ip.addr == 192.0.2.10 && tcp.port == 443` | Field-based address and TCP-port match |
| `"example"` | Free-text search |
| `tcp.stream == 0` | A numbered TCP conversation |

Combine conditions with `and`/`&&`, `or`/`||`, `not`/`!`, and parentheses. Comparisons include `==`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, and `matches`. Enter a filter and press **Enter** or **Apply**; **Esc** clears it. An invalid filter is marked with an error. The **Problems**, **TCP issues**, **DNS**, **Web**, **Discovery**, and **Routing** buttons apply useful starting filters.

### Open and save capture files

Use the folder button or drop a capture file into the view. Supported inputs include classic `.pcap`, `.pcapng`, `.cap`, `.dmp`, and supported Windows `.etl` packet traces. The input file-size limit is 1 GB. Opening a file stops any live capture in that tab before replacing its data.

Windows ETL support reads NDIS packet traces such as those recorded with `netsh trace ... capture=yes`. Arbitrary ETL event logs and `pktmon` ETL files are not supported by this importer. A trace without captured packet events cannot be analyzed as a packet capture.

Use **Open sample** when it is offered in the capture notice, or open the repository's [branch-office sample](../assets/samples/branch-office.pcapng) through the file button. The sample lets you explore decoding and insights without collecting live traffic.

The save button offers **Save all packets** and, when a filter reduces the list, **Save displayed packets**. Both write `.pcapng`. Displayed-only export is useful for isolating a conversation, but excludes all hidden packets from the new file. Captures are not automatically saved when you close the tab.

### Read packets, insights, and conversations

Select a packet to view its plain-language explanation, protocol tree, and hex bytes. Click decoded tree fields to inspect the related bytes; right-click fields or packet rows for copying and filters.

The right-side tabs summarize the retained capture:

| Tab | Use |
| --- | --- |
| **Insights** | Plain-language observations and detected conditions; click a linked insight to filter related packets |
| **Conversations** | TCP/UDP pairs with traffic totals; open or right-click a row to follow/filter it |
| **Endpoints** | Addresses and transmitted/received traffic totals |
| **Protocols** | Protocol packet counts and byte totals |
| **Neighbors** | Decoded network discovery information when present |

Insights are heuristic observations from the packets available in this capture. Missing packets, asymmetric capture, offloading, and encrypted payloads can limit interpretation. Verify a suspected problem against device state and the capture location. **Names** displays names learned from capture analysis; it does not make encrypted application payloads readable.

Right-click a TCP/UDP packet and choose **Follow … stream**, or use a conversation row. The follow window shows both directions with distinct colors, a **Hex dump** option, **Copy**, and **Filter this stream**. Its display has a 2 MB budget. It shows captured payload bytes; TLS/SSH encryption is not decrypted by this feature.

## Network tools

Open a tool from Home, the sidebar, or the toolbar's tools menu. Several result tables offer right-click actions for connecting to, pinging, scanning, looking up, or capturing a selected host. Some actions immediately start the selected test. Use scans only against hosts and networks you own or are authorized to test.

### Ping Monitor

Enter one or more hostnames/IPs separated by commas, spaces, or semicolons, then click **Start**. Set **Count** to `0` for continuous monitoring; adjust interval, timeout, and payload size as needed. Results include sent/received counts, loss, minimum/average/maximum RTT, jitter, and recent history. **Stop** ends monitoring; **Export CSV** saves the table.

For a basic local check, use `127.0.0.1`. A successful ping tests ICMP reachability; a failed ping does not alone establish that a host is down because ICMP may be blocked.

### Network Sweep

Enter a CIDR, range, or list, such as `192.0.2.0/28`, `192.0.2.1-10`, or `192.0.2.1,192.0.2.8`. Replace documentation addresses with your actual authorized network before running it. Options include **Resolve names**, **TCP fallback**, **MAC addresses**, timeout, and parallelism.

The sweep reports discovered live hosts, their detection method, and available names/MACs. MAC visibility usually depends on the local ARP cache and network segment. The TTL-based OS label is only a guess. Double-click a result to open a port scan; **Export CSV** saves the sweep. Target expansion is limited to 65,536 entries and supports IPv4 subnets/ranges, single IPs, and hostnames; IPv6 subnet expansion is not supported.

### Port Scanner

Enter targets and ports such as `22,80,443` or `8000-8010`, then click **Scan**. Presets include **Top 100**, **Network gear**, **Web**, **Windows / AD**, **Databases**, **IoT / ICS**, well-known ports, and all ports 1–65535. Adjust timeout and parallelism to suit the network.

This is a **TCP connect** scanner. It reports open, closed, and filtered results; enable **Show closed / filtered** to include those rows. **Grab banners** attempts to collect service information where supported. A service name inferred from a port number is not proof of the actual software. Double-clicking an open SSH or Telnet port can connect; other ports offer related actions. **Export CSV** saves the result table.

### Traceroute

Set **Destination**, **Max hops**, timeout, and optional name resolution, then click **Trace**. KonX displays up to three RTT observations per hop and the command output. Asterisks mean no reply for that probe, which can reflect filtering or rate limiting rather than a broken forwarding path. **Stop** ends the trace.

### DNS Lookup

Enter a name or an IP for reverse lookup. Choose **A**, **AAAA**, **CNAME**, **MX**, **NS**, **TXT**, **SOA**, **SRV**, **CAA**, **All common**, or **OS resolver**. Leave **Server** empty for the default resolver or specify a DNS server. **OS resolver** uses the operating system lookup rather than a custom server. Click **Lookup** and inspect records, TTLs where returned, server, timing, and any errors.

### Whois

Enter a domain, IP, or ASN such as `example.com` or `AS64500`, then click **Lookup**. The tool shows the response from a registration service. Availability and returned detail depend on the service, network access, and registry policy.

### Subnet Calculator

Enter IPv4 CIDR, an IPv4 address plus a mask, or an IPv6 prefix. Examples: `192.0.2.37/26`, `192.0.2.37 255.255.255.192`, and `2001:db8::1/64`.

IPv4 results include network, broadcast, usable range, masks, host counts, binary/hex forms, and a reverse zone. The **Subnetting** control splits an IPv4 network into smaller subnets. IPv6 results include normalized/expanded addresses, prefix range, address count, and /64 count where applicable. The calculator supports IPv6 even though the sweep does not expand IPv6 prefixes.

### Wake-on-LAN

Enter the target MAC, a broadcast address, and UDP port (default 9), then click **Send magic packet**. A success message means the packet was sent, not that the target powered on. The target's firmware/NIC, power state, and network must support Wake-on-LAN. Directed broadcasts across routers require appropriate network configuration.

### Interfaces & ARP

Use **Refresh** to inspect local interfaces, addresses, CIDRs, networks, MACs, and the ARP cache. Right-click an interface for a subnet calculation or sweep. Right-click an ARP entry for host actions; double-clicking an ARP entry opens a port scan. The ARP table is a local cache, not a complete network inventory.

## Settings

Click the gear icon, make changes, and choose **Save**.

| Page | Controls |
| --- | --- |
| **Appearance** | Dark/light application theme; terminal color scheme, font, size, cursor shape, blink |
| **Terminal** | Scrollback; right-click behavior; copy on select; multi-line paste confirmation; remote tab titles; default log folder |
| **File Transfer** | Initial local folder; conflict policy; simultaneous transfers; hidden files |
| **Known Hosts** | Saved SSH host keys and removal |

Defaults include a dark theme, terminal font size 14, block cursor, 10,000 scrollback lines, copy on select, a context menu on right-click, multi-line paste confirmation, Ask on SFTP conflicts, and two simultaneous transfers. Per-session color scheme/font size can override terminal defaults in **Terminal & Log**.

Notepad's wrap/map/whitespace options are managed in its own menu and toolbar. Its language, encoding, and line-ending choices apply to the document. Saved session connection settings are edited from that session rather than the global settings dialog.

## Keyboard reference

Shortcuts depend on the focused view. Notepad has its own document navigation; a terminal needs focus for terminal copy/search shortcuts.

### Application and terminal

| Shortcut | Action |
| --- | --- |
| **Alt+Q** | Focus toolbar quick connect |
| **Alt+1…9** | Select an application tab by position |
| **Ctrl+Tab / Ctrl+Shift+Tab** | Next/previous application tab; within multi-document Notepad, next/previous document |
| **Ctrl+Shift+W / Ctrl+F4** | Close active application tab |
| **Ctrl+Shift+C / Ctrl+Insert** | Copy terminal selection |
| **Ctrl+Shift+V / Shift+Insert** | Paste into terminal |
| **Ctrl+Shift+F** | Find terminal scrollback; Find in Files when editing in Notepad |
| **Ctrl+= / Ctrl+- / Ctrl+0** | Increase/decrease/reset terminal or Notepad zoom |
| **Shift+Page Up / Shift+Page Down** | Scroll terminal history |
| **F12** | Toggle developer tools |

### Sessions and SFTP

| Shortcut | Action |
| --- | --- |
| **Enter** | Connect a selected saved session; in SFTP, open a folder or transfer a file |
| **F2** | Edit a saved session; rename a selected SFTP item |
| **Delete** | Delete a saved session definition; delete selected SFTP items with confirmation |
| **F5** | Refresh the focused SFTP pane |
| **Backspace** | Go up one directory in SFTP |
| **Ctrl+A** | Select all entries in the focused SFTP pane |

### Notepad editor

| Shortcut | Action |
| --- | --- |
| **Ctrl+N / Ctrl+O** | New document / open local files |
| **Ctrl+S / Ctrl+Alt+S / Ctrl+Shift+S** | Save / Save As / Save All |
| **Ctrl+W / Ctrl+Shift+T** | Close document / reopen last closed local file |
| **Ctrl+Page Down / Ctrl+Page Up** | Next/previous document |
| **Ctrl+Z / Ctrl+Y** | Undo / redo |
| **Ctrl+F / Ctrl+H** | Find / replace |
| **F3 / Shift+F3** | Next/previous match |
| **Ctrl+G** | Go to line |
| **Ctrl+D / Ctrl+L** | Duplicate/delete line |
| **Ctrl+Shift+Up / Ctrl+Shift+Down** | Move line up/down |
| **Ctrl+J / Ctrl+Q** | Join lines / toggle comment |
| **Ctrl+U / Ctrl+Shift+U** | Lowercase/uppercase |
| **Alt+click / Shift+Alt+drag** | Multiple cursors / column selection |
| **F1** | Editor command palette |

## Application data and backups

KonX's normal Windows profile is under `%APPDATA%\KonX`. Installed and portable launches use that profile unless a custom `KONX_USERDATA` directory is explicitly supplied. The default log location is separate, under `Documents\KonX\Logs`.

| Profile item | Purpose |
| --- | --- |
| `settings.json` | Appearance, terminal, transfer, button-bar, and Notepad preferences |
| `sessions.json` | Saved sessions, folders, and encrypted secret values |
| `known_hosts.json` | Accepted SSH fingerprints |
| `notepad/session.json` | Editor document list and restore information |
| `notepad/backup/*.txt` | UTF-8 recovery text for unsaved editor work |
| Chromium/Electron profile files | UI state such as recent sessions and expanded folders |

To back up the application state, close KonX and copy its whole profile directory to a protected backup location. Back up logs, captures, and files you edited separately. Copying the executable alone does not back up your sessions or editor recovery.

Password/passphrase encryption does not encrypt all application data. Session names/hosts, notes, logon-action strings, logs, capture files, remote-editor temporary copies, and Notepad recovery text may contain sensitive information in ordinary readable form. Protect the profile and artifacts accordingly.

Windows-encrypted secrets are not a portable credential export. After moving a profile to another account or computer, expect to re-enter saved secrets and check key-file paths. There is no complete session/profile export-and-import UI in this release.

For an isolated profile, advanced users can launch from PowerShell with a separate writable folder:

```powershell
$env:KONX_USERDATA = Join-Path $env:LOCALAPPDATA 'KonX-TestProfile'
& '.\KonX-0.1.2-portable.exe'
```

Run this from the folder containing the portable executable. The environment variable applies to that PowerShell process and launches from it; use a normal shortcut or a separate shell for your normal profile. This setting does not make Windows-encrypted credentials portable.

## Troubleshooting

| Symptom | Checks and recovery |
| --- | --- |
| **A connection tab stays after clicking X** | Use version 0.1.2 or newer. **Ctrl+Shift+W** or **Ctrl+F4** closes the active application tab. Verify you are clicking the connection tab's X rather than a saved session or a Notepad document. |
| **SSH times out or is refused** | Check the host, SSH port, reachability, VPN, firewall, and server service. Use Ping/Port Scanner where authorized. Review the session's timeout and jump host. |
| **SSH authentication fails** | Verify username, authentication method, key-file path, key passphrase, and server policy. Check the OpenSSH agent when using the default Windows agent method. Answer keyboard-interactive challenges as requested. |
| **Unexpected host-key change** | Compare the old and new fingerprints with a trusted administrator. Replace the saved key only after establishing the reason. |
| **Imported sessions behave differently** | Review the limited importer support above. Enter missing credentials, jump-host links, forwards, terminal settings, and actions in the session editor. |
| **Serial port missing or cannot open** | Refresh the list; verify drivers, cable, COM number, and serial parameters; close other programs using the port. Check whether the build includes serial support. |
| **Garbage characters in a serial console** | Match baud, data bits, parity, stop bits, and flow control to the device. |
| **An SFTP tab closes with its SSH terminal** | This is expected for SFTP opened from that terminal's shared transport. Use saved-session **Connect SFTP** for a separate connection. |
| **SFTP transfer failed** | Check the transfer row's error, destination path/permissions, disk space, and transport. Reconnect if needed, then reselect and re-queue the source. Unsafe local filenames must be renamed on the server. |
| **Remote save failed in Notepad** | Keep the document open and save a local copy if needed. Check whether its original SFTP tab is still connected. Reopening SFTP does not automatically rebind an old remote document; open the remote file again and deliberately transfer your changes. |
| **Default-app remote edit reports retrying** | Keep SFTP open, preserve the local path shown in the error, and wait for **Uploaded …**. If the connection is gone, reconnect and upload that saved local copy manually. |
| **Notepad text looks incorrectly encoded** | Preserve current unsaved work, then use **Encoding → Reopen as …** on the local file. Choose the intended encoding and line endings before saving. |
| **A document is read-only** | Binary-looking files open read-only. Use a suitable binary editor for binary content; the Notepad **Make editable** option does not make binary round-trips lossless. |
| **Live capture unavailable** | Select a supported built-in adapter or install Npcap separately. Check the adapter and any required administrator permission. File analysis remains available without live capture. |
| **Capture shows no packets** | Select the adapter carrying the traffic, check filter syntax, briefly try no capture filter, and reproduce traffic. For localhost traffic, use Npcap loopback capture. |
| **Capture filter rejected** | Use BPF for an Npcap device and KonX filter syntax for a built-in device. The display-filter row always uses KonX syntax. |
| **ETL opens with no captured packets** | Use a supported NDIS trace recorded with packet capture enabled; an arbitrary ETL or pktmon ETL is not accepted. |
| **Insights disagree with another observation** | Check capture placement, missing/dropped packets, offloading, filter exclusions, and whether both directions were captured. Treat analysis as evidence to investigate. |
| **Sweep misses a known device** | ICMP/TCP probes may be blocked; names/MACs may be unavailable off-link. Verify reachability and service ports directly. |
| **Wake-on-LAN sends but the machine stays off** | Check firmware/NIC power options, wired connectivity, target MAC, broadcast selection, and router policy. |

## Reporting a problem

Open a [GitHub issue](https://github.com/256kMagic/KonX/issues) with:

1. KonX version, Windows version, and installed/portable launch type.
2. The view/protocol and exact steps that reproduce the behavior.
3. What you expected and what appeared, including the exact error text.
4. Whether it repeats with a fresh connection or an isolated profile.
5. A minimal sanitized screenshot, configuration example, or capture only when needed.

Remove credentials, private keys, host inventories, personal paths, sensitive command output, and packet payloads before posting publicly. Review redaction yourself even when using **Copy config without secrets**. Developer-tools output from **F12** can help with a reproducible UI failure, but inspect it for sensitive values before sharing it.
