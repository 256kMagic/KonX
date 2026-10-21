# AI & Knowledge

KonX 0.4.0 includes an AI assistant and an offline reference library. Open **AI & Knowledge** from Home, the sidebar, or Network Tools. The assistant explains findings, terminology, and possible next steps. It does not run commands or tools, change device settings, or connect to sessions on your behalf.

## Connect a provider

Select a provider, review the model ID, enter its API key, and choose **Save connection**. Saving does not make a network request. Keys are encrypted for the current Windows account and stored separately from session settings. A saved key is never returned to the page. Each provider keeps its own key and model setting; **Forget key** removes the selected provider's saved key. API access and billing belong to the provider account.

| Provider | Credential and API |
| --- | --- |
| OpenAI | OpenAI API key; requests use the [Responses API](https://developers.openai.com/api/docs/guides/text) with response storage disabled. |
| Claude (Anthropic) | Anthropic API key; requests use the [Messages API](https://platform.claude.com/docs/en/api/messages). |
| Gemini (Google) | Gemini API key; requests use [generateContent](https://ai.google.dev/api/generate-content). |
| Nyquest | Personal API key created in **app.nyquest.ai → Settings → API Keys**. KonX uses the [OpenAI-compatible chat endpoint](https://docs.nyquest.ai/developer-api/openai-compatibility) and defaults to `nyquest/auto`. You can enter an exact accessible `vendor/model` ID instead. |
| Custom | An OpenAI-compatible **Chat Completions** endpoint, its API key, and an exact model ID. Enter the API base URL, for example `https://gateway.example/v1`; KonX appends `/chat/completions`. This is not an arbitrary API adapter. |

Built-in provider destinations are fixed. Custom connections require HTTPS, except explicitly configured HTTP on `localhost`, `127.0.0.1`, or `[::1]` for a local service. Changing a saved custom destination requires entering the key again or forgetting it first. Redirects are rejected rather than forwarding credentials.

Provider model availability changes. The editable model field lets you select an ID your account supports. A subscription to a provider's consumer chat application does not itself configure an API key in KonX.

Nyquest personal API keys carry the account's privileges, as described in its [PAT documentation](https://docs.nyquest.ai/developer-api/personal-api-keys). KonX sends chat requests only. Nyquest PAT chat requests are stateless, so KonX supplies the relevant local references explicitly; it does not retrieve Nyquest's web chat history or memory. If Nyquest reports a pending settlement, check its Usage page before repeating a generation.

## Ask about tools and results

1. Run a KonX tool and review its results.
2. Choose **Explain with AI** in that tool's heading. This prepares a bounded snapshot in a new AI tab; it does not contact a provider. Packet-capture snapshots use displayed statistics and analysis, not raw packet bytes. Saved sessions and editor documents are not gathered.
3. Edit the question. Open **Optional context**, choose **Preview context**, and review the redacted text. Select **Send this context** if you want it included. Editing the context invalidates the preview and clears that selection.
4. Choose **Ask AI**. Your question and up to five matching local reference excerpts are sent to the selected provider. Optional tool context is included only when selected. Hostnames, addresses, and other operational details can remain in a preview; remove anything you do not want to send.
5. Read the answer alongside its reference list. Open a referenced article to inspect the guidance. **Open source** opens its HTTPS documentation link in your browser. References indicate the context supplied to the model; they are not independent verification that every generated claim is correct.

Recognized credentials and saved AI keys are redacted from previews, requests, reference excerpts, and answers. Redaction is best effort. Provider responses and library articles are displayed as text. Instructions embedded in reports or reference notes are treated as evidence rather than instructions to run commands. AI recommendations still need review against the actual device model, software version, permissions, and evidence.

**Cancel** stops the current request; closing its tab or quitting KonX cancels its work. Changing AI settings cancels older AI jobs, and stale tabs must refresh their settings. Requests have a 60-second deadline and a 2 MiB response limit. KonX does not automatically retry a failed or interrupted generation. Responses may be incomplete if the provider reaches its output limit. Each question is independent; previous answers are not automatically sent as chat history.

## Use the offline library

The library is available without an API key. Search for a tool, vendor, protocol, or finding, then select an article. Bundled articles are original KonX explanations with official documentation links. They cover the built-in tools, networking and packet-analysis terms, Windows posture checks, wireless observations, Mist/Marvis, and vendor troubleshooting guidance. They are not live vendor documentation or a complete vulnerability database.

Choose **Add note** to write or paste your own reference. Supply a title, optional vendor and HTTPS source link, and up to 32,000 characters of content. Notes are stored as plain local text in the library, then indexed in the background. Do not use notes to store credentials. Relevant notes can be included as references in later AI questions. Use **Edit note** or **Remove note** to maintain custom articles; bundled guidance is read-only. **Ask about this** prepares the selected article as optional context for review.

KonX rebuilds the index after note changes and reconciles bundled article updates at startup while retaining custom notes. **Rebuild index** refreshes vectors from the articles. The library status displays document and chunk counts plus the retrieval method.

## Storage and background operation

The library uses a real local SQLite database at `%APPDATA%\KonX\knowledge\library.sqlite`, with documents, overlapping text chunks, persistent vectors, and index metadata. SQLite work and indexing run in a dedicated background worker so they do not block the application interface. Database changes commit as transactions. A damaged database is reported as unavailable and retained for recovery; KonX does not silently erase it.

Retrieval uses **local TF-IDF cosine vectors**, with limited terminology expansion. This is word-based vector retrieval, not neural semantic embeddings. It requires no embedding API key, model download, separate database server, or background cloud traffic. Queries retrieve relevant excerpts for the assistant; an answer without local matches is marked as relying on the model's general knowledge. As the library grows, neural embeddings and a larger-scale vector index can be added without changing the user-facing library workflow.

AI connection settings are in `%APPDATA%\KonX\ai.json`. Library notes and the index stay local unless relevant excerpts are sent in an explicit **Ask AI** request. KonX does not automatically index sessions, terminal output, captures, editor files, Mist credentials, or diagnostic logs. AI questions and answers are held in the open tab and are not saved as a conversation history.

## Troubleshooting

- **Access rejected:** check the key, selected model, provider permissions, and API billing. KonX displays a bounded error instead of a raw provider response.
- **Saved key cannot decrypt:** re-enter or forget the affected key under the same Windows account. Keys encrypted for another Windows user cannot be assumed portable.
- **Custom endpoint fails:** confirm its base URL and Chat Completions compatibility. A URL ending in `/chat/completions` is not the base URL expected by this field.
- **Library unavailable:** retain the database and its journal files. If startup reports corruption or an incompatible schema, preserve a copy before recovery work; do not delete it to clear the error.
- **Weak or missing explanation:** refine the question, preview relevant results, and add an accurate reference note. Check the linked vendor documentation and the original tool evidence.
