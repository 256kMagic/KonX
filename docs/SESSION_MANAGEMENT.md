# Session management

Available in KonX 0.15.0. The General page of the session editor now keeps username, password, and password saving together. Home also has a button for clearing recent session history.

## Save a username and password

1. Choose **New session** in the toolbar or beside **Sessions**.
2. On **General**, enter the name, host, port, and username.
3. Enter the password under **Login credentials**. Keep **Save password on this computer** selected to retain it for future connections. This is selected by default for new sessions when secure encryption is available.
4. Choose **Save**, or **Save & Connect** to save and immediately connect.

The username is saved with the session. Passwords use Windows-backed encryption and are never filled back into the editor or included in session-list responses. An existing password appears as a saved-password placeholder; leaving the field blank retains it.

For a one-time password, clear **Save password on this computer**, enter the password, and use **Save & Connect**. The typed password is used for that connection only. On an existing session, this does not replace or remove its previously saved password.

To forget a saved password, edit the session, select **Remove saved password**, and choose **Save**. This keeps the username and other session settings. You can also enter a one-time password and choose **Save & Connect** while removing the old saved password.

SSH key files, key passphrases, and SSH agent choices remain on **Authentication**. Telnet uses the username and password to answer login prompts. Serial sessions do not show the login-credentials section.

## Save failures

If secure encryption is unavailable, password saving is disabled with an explanation. You can still save a username and use a typed password once with **Save & Connect**. Existing encrypted credentials are retained unless explicitly removed.

If encryption or a disk write fails, KonX reports the error and keeps the populated session editor open so you can retry. The previous saved session and its credentials remain unchanged. Once you press Save, closing the dialog cannot undo a save already in progress. KonX reports its outcome even after the dialog closes; a completed save refreshes the session list without opening a connection.

Saved credentials belong to the Windows user profile. The portable executable uses that profile too; saving a password does not make it transferable to another computer.

## Clear recent sessions

Open **Home → Recent sessions → Clear recent sessions**. This immediately clears the recent-history list and remains cleared after restart.

Saved sessions, saved credentials, open terminal connections, layouts, and other preferences stay intact. Text already entered in Home's Quick connect fields also remains. Connecting to a saved session again adds it back to history.

Recent history contains up to eight saved-session references. Clearing it does not delete session logs, SSH host keys, captures, or saved sessions. Manage those through their own controls.

See the [user guide](USER_GUIDE.md), [update guide](UPDATING.md), and [release notes](releases/0.15.0.md).
