# Session management

KonX 0.15.2 makes credential retention visible beside the login fields in the session editor and adds optional password saving to Home Quick Connect. Home also has a button for clearing recent session history, introduced in 0.15.0.

## Save a login from Home Quick Connect

1. On **Home → Quick Connect**, select SSH, Telnet, or SFTP and enter the host, port, username, and password. Password entry is masked.
2. Select **Save session and remember login**. This is unchecked by default.
3. Press **Connect**. KonX creates a saved session with the username and encrypted password, then connects. SFTP saves an SSH session; use its **Connect SFTP** action to open it again.

Leave the checkbox unchecked to connect once without creating a saved session or saving the password. The compact toolbar quick-connect field continues to open one-time connections. Raw TCP and serial do not offer login retention.

Quick Connect creates a new saved session; it does not replace an existing session with the same host. If saving fails, KonX shows the error and keeps the populated form for retry without opening a connection. Repeat clicks while saving do not create duplicate sessions. Closing Home while a save is in progress does not undo that requested save, but prevents a late connection from opening.

## Save a username and password

1. Choose **New session** in the toolbar or beside **Sessions**.
2. On **General**, enter the name, host, port, and username.
3. Enter the password under **Login credentials**. Keep **Remember username and password** selected to retain it for future connections. The checkbox sits immediately above the login fields and is selected by default for new sessions when secure encryption is available.
4. Choose **Save**, or **Save & Connect** to save and immediately connect.

The username is saved with the session. Passwords use Windows-backed encryption and are never filled back into the editor or included in session-list responses. An existing password appears as a saved-password placeholder; leaving the field blank retains it.

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

See the [user guide](USER_GUIDE.md), [update guide](UPDATING.md), and [release notes](releases/0.15.2.md).
