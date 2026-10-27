# AI & Knowledge

This guide covers AI & Knowledge in KonX 0.33.0. Open **AI & Knowledge** from Home, the sidebar, or Network Tools. The standalone assistant explains findings, terminology, and possible next steps. KonX-AI separately offers [reviewed actions](KONX_AI.md#reviewed-actions): bounded diagnostics, selected editor replacements and new answer notes, each requiring a prepared review and an explicit execution click. Neither assistant automatically connects sessions or changes device settings.

The new [KonX-AI](KONX_AI.md) keeps conversations beside supported tools and previews the complete outbound request. **AI & Knowledge** remains the place to configure providers and manage the offline reference library. Its existing standalone assistant remains available.

## Connect a provider

Select a provider, review the model ID, enter its API key, and choose **Save connection**. Saving does not make a network request. Keys are encrypted for the current Windows account and stored separately from session settings. A saved key is never returned to the page. Each provider keeps its own key and model setting. API access and billing belong to the provider account.

After a successful save, the key field becomes empty and the status confirms that an encrypted key is saved. The empty field does not mean the saved key is missing. KonX-AI reuses that provider's saved key for connection tests and requests, including after closing a panel or restarting the app. Saving model changes with an empty key field keeps the existing key. Enter a new key only to add or replace one.

Choose **Delete saved key** to remove the selected provider's key from the local store. Other providers' keys remain saved. Deletion does not save or discard a replacement key or other unsaved connection edits in the form. This does not revoke the key at the provider; manage remote revocation in that provider's account. After deletion, that provider needs a new saved key before another request or connection test.

If saving fails, the entered key remains in the open settings form so you can correct the error and retry. Pending key or connection changes are drafts until you save them; closing or changing providers requires discarding those changes explicitly. Unsaved drafts do not survive an application exit.

| Provider | Credential and API |
| --- | --- |
| OpenAI | OpenAI API key; requests use the [Responses API](https://developers.openai.com/api/docs/guides/text) with response storage disabled. |
| Claude (Anthropic) | Anthropic API key; requests use the [Messages API](https://platform.claude.com/docs/en/api/messages). |
| Gemini (Google) | Gemini API key; requests use [generateContent](https://ai.google.dev/api/generate-content). |
| Nyquest | Personal API key created in **app.nyquest.ai → Settings → API Keys**. KonX uses the [OpenAI-compatible chat endpoint](https://docs.nyquest.ai/developer-api/openai-compatibility) and defaults to `nyquest/auto`. You can enter an exact accessible `vendor/model` ID instead. |
| Custom | An OpenAI-compatible **Chat Completions** endpoint, its API key, and an exact model ID. Enter the API base URL, for example `https://gateway.example/v1`; KonX appends `/chat/completions`. This is not an arbitrary API adapter. |

Built-in provider destinations are fixed. Custom connections require HTTPS, except explicitly configured HTTP on `localhost`, `127.0.0.1`, or `[::1]` for a local service. Changing a saved custom destination requires entering the key again or deleting it first. Redirects are rejected rather than forwarding credentials.

Provider model availability changes. The editable model field lets you select an ID your account supports. A subscription to a provider's consumer chat application does not itself configure an API key in KonX.

Nyquest personal API keys carry the account's privileges, as described in its [PAT documentation](https://docs.nyquest.ai/developer-api/personal-api-keys). KonX sends chat requests only. Nyquest PAT chat requests are stateless, so KonX supplies the relevant local references explicitly; it does not retrieve Nyquest's web chat history or memory. If Nyquest reports a pending settlement, check its Usage page before repeating a generation.

## Ask about tools and results

1. Review the existing result, terminal selection or editor document in its normal view.
2. Choose **Ask KonX-AI** (or an existing **Explain with AI** entry point). Basic tool results attach directly; views with several evidence types offer **Attach from current view** choices. Opening the panel alone does not gather data or contact a provider.
3. Inspect the retained evidence and omission notices. Select the attachments and completed turns to include, enter your question, and opt into local knowledge references if useful.
4. Choose **Prepare request** and inspect the destination, model and complete request. Choose **Send reviewed request** to send exactly that prepared request. Changes require a fresh review.
5. Read the answer alongside its source references and original tool evidence. References show the material supplied to the model; they do not independently verify generated claims. See the [KonX-AI guide](KONX_AI.md) for each tool's evidence choices and storage limits.

The standalone assistant in **AI & Knowledge** still supports **Optional context → Preview context → Send this context**, followed by **Ask AI**. Each standalone question is independent, with up to five matching library excerpts; its open-tab answers are not saved as KonX-AI conversations. Library **Ask about this** prepares the selected article for this standalone flow. Hostnames, addresses and other operational details can remain in previews; remove anything you do not want to send.

Recognized credentials and saved AI keys are redacted from previews, requests, reference excerpts, and answers. Redaction is best effort. Provider responses and library articles are displayed as text. Instructions embedded in reports or reference notes are treated as evidence rather than instructions to run commands. AI recommendations still need review against the actual device model, software version, permissions, and evidence.

From 0.18.1, recognized credentials are removed before articles are split for indexing. AI references are selected from sanitized full articles around matching query terms, so a relevant passage beyond the first 900 characters remains eligible. Answer redaction also runs before the display-length limit. Existing custom notes retain their original text; upgrading rebuilds the derived search index.

From 0.22.1, tool context also reaches redaction before excerpt shortening. The preparation boundary accepts bounded complete text; oversized fields are omitted whole. Coverage notices identify omitted fields, records, or text, so a short preview does not imply that the whole tool result was examined. Review the original result when the preview reports an omission.

Unsent questions, context edits, and unfinished knowledge notes are protected as drafts. Cancelling an AI tab close keeps them; discarding closes the tab without saving the draft. Failed requests or note saves retain editable input for retry. **Update KonX** lists unfinished AI input as a blocker. Drafts remain in memory and are not restored after KonX exits; save or copy needed input before quitting the application.

**Cancel** stops the current request; closing its tab or quitting KonX cancels its work. Changing AI settings cancels older AI jobs, and stale tabs must refresh their settings. Requests have a 60-second deadline and a 2 MiB response limit. KonX does not automatically retry a failed or interrupted generation. Responses may be incomplete if the provider reaches its output limit. Each question is independent; previous answers are not automatically sent as chat history.

## Use the offline library

The library is available without an API key. Search for a tool, vendor, protocol, or finding, then select an article. Bundled articles are original KonX explanations with official documentation links. They cover the built-in tools, networking and packet-analysis terms, Windows posture checks, wireless observations, Mist/Marvis, and vendor troubleshooting guidance. They are not live vendor documentation or a complete vulnerability database.

Choose **Add note** to write or paste your own reference. Supply a title, optional vendor and HTTPS source link, and up to 32,000 characters of content. Notes are stored as plain local text in the library, then indexed in the background. Do not use notes to store credentials. Relevant notes can be included as references in later AI questions. Use **Edit note** or **Remove note** to maintain custom articles; bundled guidance is read-only. **Ask about this** prepares the selected article as optional context for review.

KonX rebuilds the index after note changes and reconciles bundled article updates at startup while retaining custom notes. **Rebuild index** refreshes vectors from the articles. The library status displays document and chunk counts plus the retrieval method.

## Storage and background operation

The library uses a real local SQLite database at `%APPDATA%\KonX\knowledge\library.sqlite`, with documents, overlapping text chunks, persistent vectors, and index metadata. SQLite work and indexing run in a dedicated background worker so they do not block the application interface. Database changes commit as transactions. A damaged database is reported as unavailable and retained for recovery; KonX does not silently erase it.

Retrieval uses **local TF-IDF cosine vectors**, with limited terminology expansion. This is word-based vector retrieval, not neural semantic embeddings. It requires no embedding API key, model download, separate database server, or background cloud traffic. Queries retrieve relevant excerpts for the assistant; an answer without local matches is marked as relying on the model's general knowledge. As the library grows, neural embeddings and a larger-scale vector index can be added without changing the user-facing library workflow.

AI connection settings are in `%APPDATA%\KonX\ai.json`. Library notes and the index stay local unless relevant excerpts are included in an explicit request. KonX does not automatically index sessions, terminal output, captures, editor files, Mist credentials, or diagnostic logs. Standalone AI questions and answers are held in the open tab. KonX-AI separately saves local conversations, explicitly attached evidence, exact reviewed requests and completed answers.

## Troubleshooting

- **Access rejected:** check the key, selected model, provider permissions, and API billing. KonX displays a bounded error instead of a raw provider response.
- **Empty key field after saving:** check the saved-key status. The field intentionally stays blank; a saved key is reused without re-entry.
- **Save failed:** correct the reported error and retry with the retained draft. A failed save does not replace a previously saved key.
- **Saved key cannot decrypt:** replace or delete the affected key under the same Windows account. Keys encrypted for another Windows user cannot be assumed portable.
- **Custom endpoint fails:** confirm its base URL and Chat Completions compatibility. A URL ending in `/chat/completions` is not the base URL expected by this field.
- **Library unavailable:** retain the database and its journal files. If startup reports corruption or an incompatible schema, preserve a copy before recovery work; do not delete it to clear the error.
- **Weak or missing explanation:** refine the question, preview relevant results, and add an accurate reference note. Check the linked vendor documentation and the original tool evidence.
