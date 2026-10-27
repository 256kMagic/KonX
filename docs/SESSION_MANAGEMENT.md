# Session management

KonX 0.32.0 lets you save connections after opening them on demand. You can also create sessions before connecting, save a Home Quick Connect login, and clear recent history.

From 0.31.0, Home sections can be hidden. If **Quick connect** or **Recent sessions** is absent, open **Home → Customize Home**, select the group, and **Save**. Hiding a group keeps saved sessions and history intact. See [Customize Home](USER_GUIDE.md#customize-home).

## Save an on-demand connection

1. Open the terminal or SFTP connection you want to keep. Connections opened from Home, the compact quick-connect bar, and network-tool actions are supported.
2. Click **Save session** above the terminal or file panes, or right-click the application tab and choose **Save session**.
3. Review the filled-in connection settings. Choose a **Name** and **Folder**; a folder such as `Lab/Switches` is created when needed.
4. Review **Login credentials**. Keep **Remember username and password** selected to save an entered password with Windows-backed encryption. Clear it to save the connection settings and username without a password.
5. Choose **Save**. The session appears in the Sessions sidebar, and the current connection keeps running.

After saving, the control becomes **Edit saved session** and opens the same record. Saving changes there applies to future connections opened from Sessions; it does not alter the current connection. Cancel before pressing Save leaves the session unchanged. The save form does not offer **Save & Connect**, because the connection is already open.

SSH, Telnet, raw TCP, serial, and SFTP connections can be retained. SFTP uses an SSH session record and can be reopened using **Connect SFTP** from that record. An SFTP tab opened from a terminal shares that terminal's saved-session association, so saving from either view targets the same record. Serial settings, including an **Auto detect** baud choice, stay part of the saved configuration.

A password originally entered into Quick Connect can be reviewed in the masked password field. Passwords or challenge answers entered later in login prompts, including one-time codes, are not recovered from terminal output. Enter a reusable password in the save form if you want it retained. Existing encrypted passwords are never filled back into the editor.

Repeated clicks while a save is in progress do not create duplicate sessions. A failed save leaves the populated form open for retry. Once Save is pressed, closing the dialog or tab cannot undo a write already in progress; KonX reports its outcome and keeps a completed saved record available from Sessions.

## Save a login from Home Quick Connect

1. On **Home → Quick Connect**, select SSH, Telnet, or SFTP and enter the host, port, username, and password. Password entry is masked.
2. Select **Save session and remember login**. This is unchecked by default.
3. Press **Connect**. KonX creates a saved session with the username and encrypted password, then connects. SFTP saves an SSH session; use its **Connect SFTP** action to open it again.

Leave the checkbox unchecked to connect once without creating a saved session or saving the password. The compact toolbar quick-connect field opens an on-demand connection; use its tab's **Save session** action afterward to keep it. Home Quick Connect does not offer login retention for raw TCP or serial.

Quick Connect creates a new saved session; it does not replace an existing session with the same host. If saving fails, KonX shows the error and keeps the populated form for retry without opening a connection. Repeat clicks while saving do not create duplicate sessions. Closing Home while a save is in progress does not undo that requested save, but prevents a late connection from opening.

Hiding the **Quick connect** section also prevents a pending save from opening a connection and clears the form's entered password. An already requested session save may still finish; reopen it from the Sessions sidebar when needed.

## Save a username and password

1. Choose **New session** in the toolbar or beside **Sessions**.
2. On **General**, enter the name, host, port, and username.
3. Enter the password under **Login credentials**. Keep **Remember username and password** selected to retain it for future connections. The checkbox sits immediately above the login fields and is selected by default for new sessions when secure encryption is available.
4. Choose **Save**, or **Save & Connect** to save and immediately connect.

The username is saved with the session. Saved passwords use Windows-backed encryption and are never filled back into the editor or included in session-list responses. An existing password appears as a saved-password placeholder; leaving the field blank retains it.

For a one-time password, clear **Remember username and password**, enter the password, and use **Save & Connect**. The username is still saved with the session; the typed password is used for that connection only. On an existing session, this does not replace or remove its previously saved password.

To forget a saved password, edit the session, select **Remove saved password**, and choose **Save**. This keeps the username and other session settings. You can also enter a one-time password and choose **Save & Connect** while removing the old saved password.

SSH key files, key passphrases, and SSH agent choices remain on **Authentication**. Telnet uses the username and password to answer login prompts. Serial sessions do not show the login-credentials section.

## Save failures

If secure encryption is unavailable, password saving is disabled with an explanation. You can still save a username and use a typed password once with **Save & Connect**. Existing encrypted credentials are retained unless explicitly removed.

If encryption or a disk write fails, KonX reports the error and keeps the populated session editor open so you can retry. The previous saved session and its credentials remain unchanged. Once you press Save, closing the dialog cannot undo a save already in progress. KonX reports its outcome even after the dialog closes; a completed save refreshes the session list without opening a connection.

Saved credentials belong to the Windows user profile. The portable executable uses that profile too; saving a password does not make it transferable to another computer.

In 0.15.0 and 0.15.1, the editor checkbox is called **Save password on this computer**, and Home Quick Connect does not yet offer password entry or retention. Use **Update KonX** to obtain the new controls.

## Clear recent sessions

Open **Home → Recent sessions → Clear recent sessions**. This immediately clears the recent-history list and remains cleared after restart.

Saved sessions, saved credentials, open terminal connections, layouts, and other preferences stay intact. Text already entered in Home's Quick connect fields also remains. Connecting to a saved session again adds it back to history.

Recent history contains up to eight saved-session references. Clearing it does not delete session logs, SSH host keys, captures, or saved sessions. Manage those through their own controls.

See the [user guide](USER_GUIDE.md), [update guide](UPDATING.md), and [release notes](releases/0.32.0.md).
