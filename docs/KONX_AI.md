# KonX-AI

This guide covers **KonX-AI in KonX 0.29.0**. The contextual assistant was introduced in 0.23.0. Open **KonX-AI** from the toolbar, Home, or Network Tools. In Workbench it opens in the companion pane; other layouts open it as a floating panel. Existing Float, Pop out, Dock, resizing, and split controls work on the same conversation view.

## First request

1. Choose **KonX-AI Settings & Library**, configure your provider and model in AI & Knowledge, and save the connection. Saving never calls the provider. The encrypted key remains saved when the input becomes blank; tests and requests reuse it after restart. See [saved keys and deletion](AI_KNOWLEDGE_GUIDE.md#connect-a-provider).
2. Return to KonX-AI. Use the connection test to prepare a minimal test request, review it, then send it. The status distinguishes a saved configuration from a successful test of that configuration.
3. Create a conversation, or choose **Ask KonX-AI** in a supported tool to attach its current observations.
4. Inspect the saved evidence, choose which attachments and completed conversation turns to include, and enter your question. Local knowledge references are opt-in.
5. Choose **Prepare request**. Review the destination, model, exact JSON request body, selected sources, and limitations. Preparation stays local.
6. Choose **Send reviewed request**. Changing the draft, selections, provider, or conversation requires a new review. A review expires after five minutes and can be sent once.

The reviewed request includes instructions, question, selected history, evidence, and any retrieved knowledge excerpts. Authentication headers are excluded. Redaction removes configured credentials and recognized credential formats before evidence retention and sharing; inspect the preview for other sensitive text.

## Evidence and follow-ups

Version 0.23.0 supports typed evidence from Ping Monitor, IP Sweep, Port Scanner, Traceroute, DNS, Whois, Subnet Calculator, Wake-on-LAN, and Network Interfaces. Selection uses the tool's selected result rows when available. Snapshots include the original run inputs and times, status, retained facts, coverage, and omissions. Editing the tool's form does not relabel an earlier result.

Attachments are immutable copies. A changed or closed source does not alter an earlier request. Use **Open source view** to revisit an open source; attach again to use newer facts. Opening KonX-AI or changing focus does not collect or attach data automatically. Use **Attach from current view** for supported views. When several types of evidence are available, choose one in the review dialog.

Choose a saved conversation to continue it. Only selected completed turns enter the next request; cancelled, failed, and interrupted turns do not. Past source excerpts and exact requests remain attached to their original turn even if current evidence is detached. Replies are model suggestions, not verified diagnoses.

## Workspace evidence

Version 0.24.0 adds explicit choices from the current view:

| View | Evidence you can choose |
| --- | --- |
| Terminal | Selected text, visible terminal text, or connection diagnostics |
| SSH/Telnet/serial connection | Requested and observed settings, serial detection, logging state, configured forwarding rules; unobserved runtime state stays unknown |
| Saved session | Selected session configuration from its context menu; passwords, key paths, login commands and other sessions are excluded |
| SFTP | Selected or displayed local/remote file metadata, or retained transfer status and errors |
| Notepad | Selected text or the current document; other open documents are excluded |

Use the view's context menu or open KonX-AI and choose **Attach from current view**. Capture is explicit and stays local until you prepare and send a request. SFTP attachments never fetch file contents. Terminal attachments do not execute commands or read log files. Wrapped lines cut by the viewport and oversized text are omitted as whole values, with notices; choose a smaller selection when needed. Retained directory entries keep the last successful path and observation time even when a later navigation fails.

## Traffic and wireless evidence

Version 0.25.0 adds **Ask KonX-AI** in capture and assessment views. Use **Attach from current view** for the available explicit choices.

| View | How to choose evidence |
| --- | --- |
| Packet capture | Select a decoded packet, then Ask KonX-AI; only its parsed fields and frame reference are attached |
| Readable traffic | Open an analyzed stream and use its KonX-AI action; existing readable messages, directions and gaps are retained |
| SIP | Select a call in the ladder view; attach its messages and parsed SDP details |
| RTP | Select an analyzed stream; attach quality observations and packet gaps, without audio |
| Capture comparison | Select changes in the completed comparison; retain both source capture references |
| Remote capture | Attach the retained report; this does not read the capture file or start tcpdump |
| Security | Choose selected findings or retained checks from the existing report |
| Wi-Fi | Choose retained observations; no new adapter scan starts |
| Mist | Choose supported retained entities; arbitrary response bodies and credentials are excluded |

Open the normal analysis view first when its parsed result is required. Attachments use that result rather than starting another analysis. Parser limits, missing directions, frame coverage and source truncation remain visible. Already truncated source text is omitted as a whole value; an incomplete stream is not proof of packet loss on the network. Raw packet bytes, audio and unparsed payloads are excluded.

## Investigation evidence

Version 0.26.0 adds explicit KonX-AI choices in Device Inspector, Snapshots, Topology, Live Events, Sites, Incidents, Runbooks and Change Validation.

| View | Evidence you can choose |
| --- | --- |
| Device Inspector | Selected parsed facts, complete selected command output, or recorded trace candidates |
| Snapshots | Selected before/after changes with saved snapshot references |
| Topology | Selected node or link with observed provenance and uncertainty |
| Live Events | Explicitly selected retained messages and parsed fields |
| Sites | Current draft name, notes and grouped references; references are not opened or resolved |
| Incidents | Selected bounded complete text evidence, timeline or integrity information |
| Runbooks | A selected step from the completed retained report |
| Change Validation | Recorded plan, comparison evidence and explicit user decisions; drafts and manual assessments stay labeled |

Select a row or item, then use **Ask KonX-AI** or the current-view picker. For a cross-tool investigation, attach each source explicitly to the same conversation and select the attachments to include. Unknown timestamps and incomplete evidence stay unknown. Clipped graph facts and truncated command/event/incident text are omitted whole, with notices. The original tool remains available to inspect fuller evidence.

## Reviewed actions

Version 0.27.0 offers reviewed actions on completed answers. Suggestions are untrusted proposals. Choose an action, inspect its exact target and effect, then execute the reviewed action separately.

1. On a completed answer, choose **Review actions**. Select a supported suggestion or choose an action manually.
2. Enter the target and parameters. For an editor replacement, select the intended text in the open Notepad document and capture that selection in the action form.
3. Prepare the action. Review the target, units, full before/replacement text or complete note, expiry and limitations. **Technical details** contains the exact normalized review.
4. Choose **Execute reviewed action**. Inspect its retained outcome before deciding on another action. Use Running Work to reopen a closed KonX-AI panel while an action finishes.

| Action | Review and effect |
| --- | --- |
| Ping | One host, finite packet count and explicit timing; sends diagnostic traffic only after execution |
| DNS | One name, record type and optional resolver; sends a bounded query |
| Traceroute | One host, hop limit and timeout; reverse-name lookup is disabled |
| Replace editor selection | Select the intended live Notepad text, inspect the full before/replacement text, then apply one undoable edit |
| Save answer note | Review the new note title and exact completed-answer content or excerpt; creates a new local Knowledge article |

For a note excerpt, select text inside that completed answer, then choose **Use selected answer text**. **Use whole answer** restores the full answer. Selections outside the answer or across other content are rejected. The full note, including its provenance footer, appears before saving; manual character positions remain available under the expandable excerpt controls.

An action review expires after five minutes and can be used once. Changing the conversation or source answer requires a new review. Editor actions also require the same document object, model identity, monotonically increasing version, selection, text and editability at execution. Editing while a review is open makes it stale. Editor changes are not saved or uploaded automatically; use Undo to reverse an applied edit.

Results remain in the conversation with source citations, limits and status. Diagnostics retain actual observations, including partial results on cancellation. A lost editor acknowledgment or interrupted pending action is **unknown**, because an effect may have occurred. Inspect the target before making another attempt; KonX never retries automatically. Terminal command execution is outside this release: commands in an answer remain text for you to review and use manually.

Each conversation retains up to 64 actions. Diagnostics have a two-minute execution limit. Editor selections and replacements are limited to 49,152 characters each; notes have a 32,000-character limit including provenance. Long answers require a shorter excerpt. No old action is automatically removed to make room.

## Requests and storage

Conversations are local to the Windows profile. Rename or delete them from KonX-AI. Deletion removes the local conversation; it does not delete information already sent to a provider. The conversation list reports unreadable records rather than silently replacing them.

KonX saves a pending turn before sending, and saves the outcome before reporting completion. On restart, interrupted requests stay interrupted; they are never automatically resent. Cancel stops the active transport. Draft input is protected when closing the panel or updating, but unsent drafts remain in memory: save or copy important text before quitting the application.

Limits are explicit: 100 conversations, 100 turns and 32 attachments per conversation, eight selected attachments, 12 selected history turns, 8,000 question characters, 50,000 answer characters, 64 KiB per snapshot, 256 KiB per request, 4 MiB per conversation, and 32 MiB for the conversation library. Oversized input is rejected or identified as omitted by its source producer. No automatic deletion makes room for new records.

## Provider behavior

OpenAI Responses and compatible Chat Completions adapters can receive streamed responses. Other adapters use buffered responses. KonX holds answer text until the complete answer can be redacted and validated, so the display does not expose unredacted fragments. Progress and cancellation remain available. Token usage is shown only when supplied by the provider; missing counts stay unknown. No cost is invented.

Request and source text remain untrusted evidence. From 0.27.0, only the reviewed action catalog above can run after your explicit execution click. Model text cannot call application operations directly. Terminal commands, session connections, file saves/uploads and device configuration changes remain manual.

See [AI & Knowledge](AI_KNOWLEDGE_GUIDE.md) for provider setup, [workspace layouts](WORKSPACE_LAYOUTS.md) for placement, and [updating](UPDATING.md) for upgrades.
