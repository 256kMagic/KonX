# SSH compatibility

KonX 0.15.1 uses SSH 2 for terminal sessions, SFTP, jump hosts, forwarding, and tools that reuse an authenticated SSH connection. Transport negotiation and the private key used to log in are separate parts of an SSH connection. This release broadens both kinds of compatibility, with the limits below.

## Connect to modern and older devices

Edit the saved session, open **Connection**, and choose **SSH transport compatibility**:

| Setting | Behavior |
| --- | --- |
| **Automatic — modern preferred, legacy allowed** | Prefer modern transport algorithms and allow supported legacy choices when the peer requires them. This is the default for new sessions and older sessions without an explicit setting. |
| **Modern transport only** | Exclude legacy transport choices such as RSA/SHA-1 host signatures, SHA-1 key exchange, CBC/3DES/RC4 ciphers, and legacy MACs. Devices that require those choices will fail negotiation. |

Choose **Save** or **Save & Connect**. The choice applies to that saved session's terminal and standalone SFTP connections. SFTP opened from a connected terminal reuses the terminal's established connection. Each jump host uses its own saved setting; the destination's setting applies to the final connection.

An unknown or invalid saved compatibility value is rejected. Edit the session and choose one of the supported settings explicitly; it will not silently enable legacy algorithms.

Automatic offers modern choices first and includes only legacy algorithms supported by the running SSH/crypto implementation. The Windows Electron runtime supports RSA/SHA-1 (`ssh-rsa`) host signatures, Diffie–Hellman group1/group14 with SHA-1, AES-CBC and 3DES-CBC, Blowfish-CBC, RC4 (`arcfour` variants), and legacy HMAC choices including SHA-1, MD5, and truncated variants. The terminal reports legacy choices that were actually negotiated. Permitting these choices does not make them as strong as modern alternatives.

**DSA (`ssh-dss`) is not supported in the Windows Electron release**, for either server host signatures or private-key authentication. A server offering only a DSA host key cannot connect even in Automatic mode. A source run under Node.js can have different crypto capabilities; a successful source test does not establish support in the Windows app.

**Modern transport only** controls server host signatures, key exchange, ciphers, and MACs. It does not change the separate user-key signature negotiation used to authenticate your login.

KonX still verifies the server's host fingerprint in either mode. A changed fingerprint requires the normal host-key decision; compatibility mode never automatically accepts or replaces it. The Security Suite's SSH audit uses the same transport policy and reports the choices from one handshake. It does not authenticate, execute commands, establish trust in the observed host key, or enumerate every algorithm the server offers.

## Choose a private key

In the session editor, enter **Username** on **General**. Under **Authentication**, choose **Public key file**, select the private-key file, and provide its passphrase when prompted. The corresponding `.pub` file is the public half and cannot authenticate by itself.

An SSH agent is another authentication method. Select **SSH agent (Pageant / OpenSSH)** to use an available agent. The agent must hold the desired key and support the signature the server requests.

Transport compatibility cannot repair a malformed key, recover a forgotten passphrase, or cause a server to authorize a key it does not recognize.

## Supported private keys

The Windows release supports **RSA**, **ECDSA NIST P-256/P-384/P-521**, and **Ed25519** identities in the following formats, including supported encrypted variants. RSA 1024-bit and 2048-bit identities are included in the compatibility fixtures; support for an older key size is not a recommendation to create new keys of that size.

| File format | Support and details |
| --- | --- |
| **OpenSSH private key** | `BEGIN OPENSSH PRIVATE KEY`, including bcrypt-protected encrypted files supported by the bundled SSH library. |
| **Traditional PEM private key** | RSA and EC private-key headers, including encryption supported by the runtime. |
| **PKCS#8 private key** | `BEGIN PRIVATE KEY` or `BEGIN ENCRYPTED PRIVATE KEY`, including supported encrypted RSA, ECDSA, and Ed25519 files. |
| **PuTTY PPK v2** | Unencrypted or AES-256-CBC encrypted files, with the file's integrity check verified before use. |
| **PuTTY PPK v3** | Unencrypted or AES-256-CBC encrypted files; encrypted files support Argon2d, Argon2i, and Argon2id, with integrity verification. |

Format support does not imply support for every encryption or key-derivation setting. A public `.pub` file cannot substitute for its private half. SSH 1 keys, DSA in the Windows runtime, FIDO/security-key private-file formats, OpenSSH certificate authentication, and Ed448 are unsupported. Agent availability does not establish support for an otherwise unsupported key type or certificate workflow.

KonX converts supported formats in memory and never rewrites the selected key file. For PuTTY keys, integrity validation covers the key metadata and private contents. Incorrect passphrases and damaged encrypted files can produce the same integrity error; the error does not prove which one occurred.

### Unlocking, cancellation, and limits

KonX loads and unlocks a private key **before starting the network connection timeout**. Entering a passphrase does not consume that timeout. A missing, unreadable, malformed, unsupported, or still-locked key stops the connection with a specific error instead of silently switching to password login. After a valid key is loaded, the server may reject it and offer password or keyboard-interactive authentication through the existing login flow.

Closing or disconnecting a pending connection cancels username/passphrase prompts, key decoding, the network login, and pending jump-host forwarding. A late prompt reply cannot open a new socket, resume an expired login, or save a host fingerprint after cancellation or timeout. Host-key and server authentication prompts shown after the connection starts still consume its network timeout.

Key derivation runs in a background worker. KonX limits key files to **1 MiB**, concurrent key decoders to **two**, and each decode attempt to **15 seconds**. PuTTY Argon2 parameters are capped at 128 MiB memory, 64 passes, 16 lanes, and a memory-times-passes budget of 1 GiB; all caps apply together. OpenSSH bcrypt is limited to 1,024 rounds, and PKCS#8 derivation also has iteration, memory, and work limits. RSA keys above 16,384 bits or with unusually large exponents are rejected.

If a valid file exceeds a limit or uses unsupported encryption, preserve the original and re-export a separate copy with standard parameters in its key-management tool. KonX does not convert or replace the file on disk. If two keys are already unlocking, retry after one finishes.

## Troubleshooting

| Error or observation | Check |
| --- | --- |
| No matching key exchange, host signature, cipher, or MAC | Use **Automatic** for a device that requires legacy SSH 2 transport. If it still fails, retain the exact error and the device's SSH software/version. |
| Cannot read the key file | Check the selected path and your file permissions. A moved or unavailable file must be selected again. |
| Incorrect passphrase or key integrity error | Confirm the passphrase and that the file is complete. Do not paste a private key or passphrase into a support report. |
| Unsupported key format | Record the format/header and key type, and consult the supported-format guidance for your release. A public key, certificate, and private key are different inputs. |
| DSA / `ssh-dss` unavailable | Windows KonX cannot use DSA host or login keys. Configure a supported server host key and/or authorize a supported login key. Automatic mode does not add DSA support. |
| Key exceeds a work limit or two keys are already unlocking | Follow the limit named in the error. Preserve the original before re-exporting a separate copy; retry a busy decoder after another unlock finishes. |
| Key accepted by the file reader but login denied | Confirm the username, server authorization, and server-side user-key signature policy. Transport negotiation alone does not establish that the login key is authorized. |
| Host key changed | Verify the fingerprint with the device administrator before replacing the saved key. Changing compatibility mode is not a substitute for this verification. |

For support, include the exact error text, KonX version, SSH server/device version, key type and file format, and whether the failure affects terminals, SFTP, or a jump host. Keep private-key contents and passphrases out of reports.

## Source and packaged runtime

KonX pins `ssh2` to 1.17.0 and applies a narrow, version- and hash-checked compatibility patch for group1 key exchange. When Electron lacks the named `modp2` group, the patch supplies the standard group1 parameters to native Diffie–Hellman operations. It preserves host signatures and host-key verification. Installation applies the patch; start, test, and build commands check it. Do not upgrade or replace this dependency without reviewing the patch and rerunning the Electron compatibility checks.

PPK v3 Argon2 decoding uses the pinned `@noble/hashes` dependency inside the bounded key worker. The application still relies on the packaged runtime for signing and transport algorithms. See the [0.15.1 release notes](releases/0.15.1.md#validation) for the checks performed and remaining device coverage.

For the distinction between SSH transport and authentication options, see [OpenSSH's legacy compatibility documentation](https://www.openssh.org/legacy.html). See also the [KonX user guide](USER_GUIDE.md) and [session management guide](SESSION_MANAGEMENT.md).
