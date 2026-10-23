# Guided Change Validation

Available from KonX 0.22.0. **Guided Change Validation** keeps a maintenance plan, before and after observations, explicit review decisions, and a timeline in one saved local workflow.

Opening, saving, or advancing a workflow never connects to a device, starts checks, or sends configuration commands. Collection remains in the existing Device Inspector, Runbooks, and Capture Comparison tools. Maintenance and rollback remain manual activities carried out using your own reviewed procedure.

## 1. Plan and scope

1. Open **Guided Change Validation** and choose **New validation**.
2. Enter the change name, affected scope, expected outcome, and manual rollback plan.
3. Edit the review checklist or use **Add review check**. A check describes an outcome you will review; it is not an executable command.
4. Choose **Save plan**, then **Advance to Baseline evidence**.

The scope and expected outcome are required before advancing. You can view any section using the phase buttons; viewing a section does not advance the saved workflow.

Changing a saved plan creates a new plan version and returns to planning. Snapshot selections, maintenance acknowledgment, and decisions reset. Previously attached reports remain retained under their earlier plan version, but cannot support new decisions until reviewed and attached again for the current scope.

## 2. Record baseline evidence

Use **Open Device Inspector** to collect or inspect observations explicitly, then save a device snapshot using that tool. Return to the workflow, choose **Refresh libraries**, select the baseline snapshot, and choose **Save snapshot selection**.

The evidence section also provides:

- **Open Snapshots** to inspect existing saved reports.
- **Open Runbooks** to review a selected built-in or saved diagnostic procedure. The procedure does not run until you use its own Run action.
- **Open Capture Comparison** to compare explicitly selected offline captures in the existing comparison tool.
- **Preview & attach result** to retain an existing completed Runbook or Capture Comparison report.

For an attachment, choose the open result and whether it belongs to the baseline or after phase. Review the complete JSON in the preview. You may edit it before choosing **Attach reviewed copy**. The saved copy is explicitly labelled as user-reviewed evidence; schema validation does not independently verify its origin or completeness. A failed save keeps the reviewed draft for retry.

An attachment preserves the report's uncertainty, limitations, and original source references. Manual runbook steps remain unknown until you provide your own assessment. Attaching a report does not turn its source status into a workflow verdict.

## 3. Acknowledge manual maintenance

Advance to **Manual maintenance**. Carry out your separately reviewed procedure, or record that the activity was skipped or rolled back.

Enter what was done in **Manual maintenance acknowledgment**, select **I acknowledge the manual maintenance activity**, and advance to **After evidence**. Both the note and checkbox are required. The recorded time is the local acknowledgment time; it does not independently establish when a device changed.

## 4. Record and compare after evidence

Collect and save a separate after snapshot explicitly. Select it in the workflow and choose **Save snapshot selection**. The before and after IDs must differ; reusing one snapshot cannot establish observations across a change.

Choose **Review device pairing** to inspect source identities. Automatic pairing uses the existing snapshot comparison rules and requires a unique identity. If you have evidence that different identities refer to the same device, choose an explicit pair and save the selection.

Choose **Compare saved snapshots** to run the existing comparison engine against the saved observations. The workflow retains the complete comparison, snapshot IDs, labels, save times, explicit device pairs, and comparison time. Snapshot records are immutable and have no mutable source revision. The workflow itself uses revision checks to prevent one editor from overwriting another editor's changes.

Missing or unreadable snapshots produce an unavailable comparison. Incomplete categories and ambiguous device identities retain the comparison engine's unknown results. A changed observation does not establish failure; an unchanged observation does not establish health.

Changing snapshot selections or adding reviewed evidence resets decisions for a fresh review. Unchanged snapshot selections preserve the comparison and decisions. If changed sources would discard unsaved review edits, KonX asks you to confirm the reset. Original snapshots and tool reports remain owned by their existing tools.

## 5. Review and export

Advance to **Review & export**. Review decisions are read-only until this saved phase. For each checklist item, choose **Pass**, **Fail**, or **Unknown**, enter a rationale, and select its retained evidence references. Ctrl-click selects multiple sources.

- Pass and Fail require at least one current retained source.
- Unknown is appropriate when evidence is missing, ambiguous, incomplete, or insufficient.
- The displayed assessment is derived only from your explicit decisions. It is not an automatic device or application health verdict.
- A checklist containing unreviewed decisions remains **Not fully reviewed**.

Choose **Save review decisions**. The timeline records plan changes, explicit phase transitions, source selections, comparison activity, evidence attachments, and review decisions.

**Export JSON report** and **Export HTML report** show a complete report preview before the native save dialog. The exported report contains all retained comparisons, evidence copies, decisions, rationale, source references, limitations, and timeline events. If another editor changes the workflow after preview, export stops and asks you to review the current revision.

To retain the report in an incident, select an incident and choose **Add report to incident**, then review and confirm the copy. The incident owns its independent full JSON copy. Deleting a validation removes only the workflow record; snapshots, original tool reports, and incident copies remain.

## Reopening and storage limits

Saved workflows reopen in their last saved phase without running tools or advancing. Unsaved plans, source selections, acknowledgment notes, reviewed attachment drafts, and decisions are protected by close confirmation and updater blockers. File operations and native export dialogs are guarded during shutdown/update preparation. Failed file cleanup remains owned for retry rather than disappearing from lifecycle tracking.

From 0.26.0, transient Windows sharing errors during record replacement receive a short bounded retry. KonX rechecks the temporary and destination files before each attempt; an externally changed record is rejected instead of overwritten. If a save still fails, retain your draft, address the reported file error and retry. Opening KonX-AI can attach the selected retained validation evidence without changing the workflow's phase or decisions.

Each profile supports up to 100 workflows. Each workflow has up to 24 checklist items, 12 attached reports, and 256 timeline events. Individual attachments are limited to 1 MiB, retained snapshot comparisons to 2 MiB, and the complete compact workflow record to 4 MiB. Oversized additions are rejected with the previous saved record intact; evidence is not silently truncated. Reports that exceed these workflow limits remain available in their original tool.

Notes, configuration observations, labels, and other literal text may contain sensitive information. Structured connection specifications and credential fields are rejected, but this is not a guarantee that arbitrary text is credential-free. Review exports before sharing them.

Automated tests use isolated profiles, synthetic snapshots/captures, manual-only runbook steps, and stubbed native dialogs. They verify the actual snapshot comparator, capture-comparison report retention, storage/revision/cleanup boundaries, production IPC registration, and Electron workflow UI. They do not test maintenance against physical equipment or live accounts.
