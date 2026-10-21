# Diagnostic runbooks

Available from KonX 0.12.0 under **Network Tools → Troubleshooting Runbooks**. Run a reviewed sequence of checks, keep the evidence for each step, and save your own reusable procedures.

## Start with a template

Choose the gateway, slow application, or phone-with-no-audio template. Review its steps, supply the requested host, numeric TCP port, or connected Cisco SSH session, then select **Run procedure**. Loading a template does not start network activity. **Stop** cancels the current operation and waits for its owned resources to finish before completing the job.

DNS, ping, and TCP checks run from the computer running KonX. They do not reproduce the affected client's route automatically. DNS uses a dedicated resolver for A/AAAA records; when a target has several addresses, the probe uses the first returned address and retains the resolution evidence. A device step uses the fixed Device Inspector inventory commands on a separate channel of your selected connection.

## Read the results

Each step shows pass, fail, or unknown with its evidence and elapsed time. A successful connection proves that the tested port accepted that connection; it does not establish application health or a root cause. Missing ICMP replies remain unknown. A procedure can finish with failed or unknown checks: completion means the planned sequence finished.

Manual checklist and SIP/RTP capture steps remain unknown. Select an already loaded Packet Capture tab to open its SIP or RTP view and investigate. Opening a viewer does not mark the step passed, and a runbook does not start packet collection on your behalf.

Export a result or use **Add to incident** to preserve it with related evidence. Review the selected destination before adding incident evidence.

## Save your own procedure

Edit or import a JSON definition, review the parsed steps, and save it as a new custom procedure. Update a selected custom procedure explicitly to retain its identity. Export a saved definition to share it, or remove it from the local library when no longer needed.

Definitions use schema version 1. Supported steps are `dns`, `ping`, `tcp`, `device`, `checklist`, and `capture`; typed inputs are `host`, `port`, and `connection`. A parameter can contain a literal value or an exact reference such as `{"input":"host"}`. Definitions do not execute scripts or arbitrary shell commands. Imported definitions are reviewed and validated before they can run.

For example, this procedure checks one TCP endpoint:

```json
{"schemaVersion":1,"name":"Application listener","timeoutMs":30000,"inputs":[{"id":"host","label":"Host","kind":"host","required":true},{"id":"port","label":"Port","kind":"port","required":true}],"steps":[{"id":"connect","title":"Connect to application port","kind":"tcp","target":{"input":"host"},"port":{"input":"port"},"timeoutMs":5000}]}
```

## Bounds and saved state

A definition is limited to 64 KiB, 24 steps, 12 inputs, two device steps, and five minutes overall. Regular steps allow up to 30 seconds and device steps up to three minutes, within the overall deadline. Checks run sequentially. The local library supports 200 custom procedures, with atomic updates that preserve the previous definition if a replacement fails.

Saved procedures persist across restart. Unsaved editor changes and running work block updater restart and require attention before closing the tab. Forced shutdown can discard unsaved edits. Exports and definitions are ordinary local files; share only the endpoint and evidence details you intend to disclose.
