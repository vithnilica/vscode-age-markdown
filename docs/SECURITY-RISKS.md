# Security risks

This document describes where decrypted content and passwords can be exposed
when you use Age Markdown, how serious each risk is, and what you can do about
it. It complements the short summary in the [README](../README.md#security-and-limitations).

The findings were verified on 2026-10-31 with VS Code 1.144, age 1.3.2 and
age-encryption 0.3.1 (see [Verification](#verification)).

## Summary

Age Markdown protects the **encrypted files**: what you commit to Git, sync to
the cloud or copy elsewhere is standard age ciphertext. The extension itself
never writes plaintext to disk.

It does **not** protect the **machine you edit on**. While a note is open,
its plaintext lives inside VS Code, and VS Code can write unsaved changes to
disk. Anyone with access to your user account can read the open documents in
any case.

| Scenario | Risk | Main mitigation |
| --- | --- | --- |
| Encrypted files leak (Git hosting, cloud sync, shared drive) | Low: only ciphertext and metadata are exposed | Strong passphrase |
| Laptop or disk stolen, **no** full-disk encryption | **High**: hot exit backups and deleted-file remnants may contain plaintext | Full-disk encryption |
| Laptop or disk stolen, full-disk encryption, powered off | Low | – |
| Backups or sync of the home directory (`~/.config`, `%APPDATA%`) | **Medium to high**: plaintext backups can end up in long-lived backups | Exclude the VS Code `Backups` directory |
| Someone uses your unlocked session | **High**: open notes are visible; restored backups may be shown without a password | Lock your screen; close notes |
| Malware or another process running as your user | **High**, and outside what any editor extension can prevent | Keep the machine clean |
| Other VS Code extensions, including AI assistants | **Medium to high**, depending on the extensions installed | Dedicated VS Code profile |

## What is protected

- **File content at rest.** Files use the standard age format with
  password-based (scrypt) encryption, produced by the official age TypeScript
  implementation. There is no custom cryptography.
- **No plaintext written by the extension.** Decryption and encryption happen
  in memory. Temporary files created during a save contain only ciphertext and
  are removed on failure.
- **Integrity of the original file.** Saves replace the file atomically, so a
  failed save leaves the previous version intact. External changes are
  detected and never overwritten silently.
- **Password handling.** Passwords are kept in memory only. They are never
  written to disk, settings, logs or VS Code's SecretStorage, and never passed
  to another process through arguments or environment variables.
- **No outbound data.** The extension has no telemetry and no network access,
  starts no child processes and exposes no API to other extensions.

## Exposure channels

### 1. VS Code hot exit backups (most significant)

VS Code backs up every modified, unsaved document so it can restore it after
a restart or a crash. This applies to all documents, including the `age-md:`
documents this extension provides, and extensions cannot turn it off.

**What is written:** the **complete text** of the document, not just the
changes, in plaintext. The backup also contains the document URI, which
includes the path of the encrypted file.

**Where:**

- Linux: `~/.config/Code/Backups/<workspace>/age-md/<hash>`
- macOS: `~/Library/Application Support/Code/Backups/<workspace>/age-md/<hash>`
- Windows: `%APPDATA%\Code\Backups\<workspace>\age-md\<hash>`

Other VS Code builds (Insiders, VSCodium) and portable installations use their
own user data directory.

**When:**

| Situation | Plaintext backup on disk |
| --- | --- |
| A document is modified | Written about 1 s after the change (2 s with a short auto-save delay) and refreshed as you type |
| The document is saved | Deleted |
| VS Code quits with unsaved changes, `files.hotExit` = `onExit` (default) | **Kept**, and restored on the next start |
| VS Code quits with unsaved changes, `files.hotExit` = `off` | VS Code asks whether to save; the backup is discarded afterwards |
| VS Code crashes, is killed, or the machine loses power | **Kept** |

A document that is only opened and read, never modified, is not backed up.

**Restoring without a password.** When VS Code restores a backup on the next
start, it takes the text from the backup. According to VS Code's source, this
does not require reading, and therefore decrypting, the encrypted file. The
restored text may thus be shown without asking for the password. This was
observed with a test file system provider, not with this extension.

**Deleted backups are not wiped.** Deleting a backup after a save is an
ordinary file deletion. On a disk without full-disk encryption, the content can
remain recoverable with forensic tools, especially on SSDs, where overwriting
in place is not guaranteed.

### 2. Other VS Code extensions

Open documents are available to every installed extension through the standard
VS Code API, and extensions can read them without any interaction from you.
AI assistants, language servers, spell checkers, linters and sync or
collaboration extensions may process the text, store it or send it to remote
services.

Age Markdown provides **no isolation** from other extensions and cannot
detect or prevent such access.

### 3. Process memory

While a note is open, its plaintext is held in several places in VS Code's
memory: the editor model, undo history, Markdown preview and any extension
that read it. The password is held in the extension's memory.

- **Lock All** and **Forget Passwords** only drop references. JavaScript strings
  cannot be wiped, so the data stays in memory until the garbage collector
  reclaims it and the memory is reused.
- Memory can be written to disk by the operating system: swap or page files,
  hibernation images and crash dumps.

### 4. User actions

The following actions can create plaintext copies outside the extension's
control:

- **Save As…** to a local path writes an unencrypted file. Save As inside the
  `age-md:` file system creates an encrypted file.
- Copying to the clipboard. Clipboard managers may keep a history.
- Printing, exporting the Markdown preview, sharing or Live Share sessions.
- Diff or compare views opened against plaintext files.

### 5. Remote development

With Remote SSH, WSL, Dev Containers or Codespaces, the extension runs on the
remote side. The password, the plaintext and the hot exit backups are all on
the remote machine or container, which must be trusted accordingly.

### 6. Metadata

age encrypts content, not metadata. The following are visible to anyone who
can see the encrypted files or their Git history:

- file names and directory structure
- approximate content size (ciphertext size grows with plaintext size)
- modification times and, in Git, when and how often each file changed
- that a file is password-protected (the scrypt stanza is in the plain header)

### 7. Git history and password changes

Every saved version that was committed stays in Git history, encrypted with
the password that was in use at the time. Changing the password protects only
new versions. A leaked old password still decrypts every old version
encrypted with it.

### 8. Password strength

The scrypt work factor (2^18 by default) makes each guess slow, but it cannot
compensate for a weak password. An attacker who obtains the files can attack
them offline, without any rate limit. Use a long random passphrase, for
example five or more random words.

## Recommendations

In order of impact:

1. **Use full-disk encryption** (LUKS, FileVault, BitLocker). This covers hot
   exit backups, remnants of deleted files, swap and hibernation images all at
   once. Without it, encrypting individual notes on the same machine gives
   only partial protection.
2. **Use a dedicated VS Code profile** for your notes with only the extensions
   you trust, and no AI assistants: `code --profile "Encrypted notes" ~/notes`.
3. **Optionally, set `"files.hotExit": "off"`** in your user settings. VS Code
   then asks you to save unsaved changes on exit, and discards the backups
   instead of keeping them. Consider the trade-off:
   - It is an application-wide setting. It cannot be set per document,
     workspace or profile, so you lose hot exit for **all** files in all
     projects.
   - It only affects what happens on exit. Backups are still written while you
     edit and are left behind after a crash.

   The extension does not change this setting for you; whether hot exit is
   worth more to you than the shorter exposure is your decision.
4. **Exclude the VS Code `Backups` directory** from backup tools and from
   dotfile or settings sync.
5. **Save often and close notes when you are done.** Lock your screen when you
   step away.
6. **Use a strong, unique passphrase.**

## Possible future improvements

- A `CustomEditorProvider` could encrypt its own backups. It would require a
  webview-based editor instead of the standard text editor, which is
  deliberately out of scope for this project.

## Verification

- **Source code review** of VS Code: `workingCopyBackupTracker.ts` (backups are
  scheduled for every modified working copy), `workingCopyHistoryTracker.ts`
  (Local History tracks only local files, so `age-md:` documents get no
  entries), `windowsMainService.ts` (an extension development host keeps
  backups in memory only).
- **`npm run test:backup-probe`** installs a small probe extension into a
  normal VS Code instance. The probe edits a document served by a custom file
  system provider and checks which files on disk contain its text, after
  saving, after quitting and after restarting. The test fails if VS Code's
  behaviour changes.
- **`npm run test:integration`** runs Age Markdown in a real VS Code. It checks
  that saved files contain only ciphertext and that no plaintext remains
  anywhere in VS Code's user data directory after saving.
- **`npm test`** includes tests that no plaintext or password reaches disk
  through the extension, and static checks that the sources use no child
  processes, logging, network access, telemetry or persistent secret storage.
