# KonX Copilot

KonX 0.23.0 adds a contextual assistant beside your tools. Open **Copilot** from the toolbar, Home, or Network Tools. In Workbench it opens in the companion pane; other layouts open it as a floating panel. Existing Float, Pop out, Dock, resizing, and split controls work on the same conversation view.

## First request

1. Choose **AI settings & library**, configure your provider and model in AI & Knowledge, and save the connection. Saving never calls the provider.
2. Return to Copilot. Use the connection test to prepare a minimal test request, review it, then send it. The status distinguishes a saved configuration from a successful test of that configuration.
3. Create a conversation, or choose **Ask Copilot** in a supported tool to attach its current observations.
4. Inspect the saved evidence, choose which attachments and completed conversation turns to include, and enter your question. Local knowledge references are opt-in.
5. Choose **Prepare request**. Review the destination, model, exact JSON request body, selected sources, and limitations. Preparation stays local.
6. Choose **Send reviewed request**. Changing the draft, selections, provider, or conversation requires a new review. A review expires after five minutes and can be sent once.

The reviewed request includes instructions, question, selected history, evidence, and any retrieved knowledge excerpts. Authentication headers are excluded. Redaction removes configured credentials and recognized credential formats before evidence retention and sharing; inspect the preview for other sensitive text.

## Evidence and follow-ups

Version 0.23.0 supports typed evidence from Ping Monitor, IP Sweep, Port Scanner, Traceroute, DNS, Whois, Subnet Calculator, Wake-on-LAN, and Network Interfaces. Selection uses the tool's selected result rows when available. Snapshots include the original run inputs and times, status, retained facts, coverage, and omissions. Editing the tool's form does not relabel an earlier result.

Attachments are immutable copies. A changed or closed source does not alter an earlier request. Use **Open source view** to revisit an open source; attach again to use newer facts. Opening Copilot or changing focus does not collect or attach data automatically. Use **Attach from current view** for supported views. When several types of evidence are available, choose one in the review dialog.

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

Use the view's context menu or open Copilot and choose **Attach from current view**. Capture is explicit and stays local until you prepare and send a request. SFTP attachments never fetch file contents. Terminal attachments do not execute commands or read log files. Wrapped lines cut by the viewport and oversized text are omitted as whole values, with notices; choose a smaller selection when needed. Retained directory entries keep the last successful path and observation time even when a later navigation fails.

## Traffic and wireless evidence

Version 0.25.0 adds **Ask Copilot** in capture and assessment views. Use **Attach from current view** for the available explicit choices.

| View | How to choose evidence |
| --- | --- |
| Packet capture | Select a decoded packet, then Ask Copilot; only its parsed fields and frame reference are attached |
| Readable traffic | Open an analyzed stream and use its Copilot action; existing readable messages, directions and gaps are retained |
| SIP | Select a call in the ladder view; attach its messages and parsed SDP details |
| RTP | Select an analyzed stream; attach quality observations and packet gaps, without audio |
| Capture comparison | Select changes in the completed comparison; retain both source capture references |
| Remote capture | Attach the retained report; this does not read the capture file or start tcpdump |
| Security | Choose selected findings or retained checks from the existing report |
| Wi-Fi | Choose retained observations; no new adapter scan starts |
| Mist | Choose supported retained entities; arbitrary response bodies and credentials are excluded |

Open the normal analysis view first when its parsed result is required. Attachments use that result rather than starting another analysis. Parser limits, missing directions, frame coverage and source truncation remain visible. Already truncated source text is omitted as a whole value; an incomplete stream is not proof of packet loss on the network. Raw packet bytes, audio and unparsed payloads are excluded.

## Requests and storage

Conversations are local to the Windows profile. Rename or delete them from Copilot. Deletion removes the local conversation; it does not delete information already sent to a provider. The conversation list reports unreadable records rather than silently replacing them.

KonX saves a pending turn before sending, and saves the outcome before reporting completion. On restart, interrupted requests stay interrupted; they are never automatically resent. Cancel stops the active transport. Draft input is protected when closing the panel or updating, but unsent drafts remain in memory: save or copy important text before quitting the application.

Limits are explicit: 100 conversations, 100 turns and 32 attachments per conversation, eight selected attachments, 12 selected history turns, 8,000 question characters, 50,000 answer characters, 64 KiB per snapshot, 256 KiB per request, 4 MiB per conversation, and 32 MiB for the conversation library. Oversized input is rejected or identified as omitted by its source producer. No automatic deletion makes room for new records.

## Provider behavior

OpenAI Responses and compatible Chat Completions adapters can receive streamed responses. Other adapters use buffered responses. KonX holds answer text until the complete answer can be redacted and validated, so the display does not expose unredacted fragments. Progress and cancellation remain available. Token usage is shown only when supplied by the provider; missing counts stay unknown. No cost is invented.

Copilot 0.23.0 does not execute commands, connect sessions, edit files, or run diagnostic tools. Request and source text are untrusted evidence. Follow-up actions remain yours to review and perform.

See [AI & Knowledge](AI_KNOWLEDGE_GUIDE.md) for provider setup, [workspace layouts](WORKSPACE_LAYOUTS.md) for placement, and [updating](UPDATING.md) for upgrades.
