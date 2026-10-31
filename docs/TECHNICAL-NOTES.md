# Technical notes

These are the results of the feasibility checks done before the implementation,
with the design decisions based on them. They were verified on 2026-10-31 with
VS Code 1.144, age 1.3.2 and age-encryption 0.3.1.

## 1. Passing the password to age

**Finding:** `age -p` / `age -d` read the passphrase only from the terminal
(`/dev/tty`, or the console on Windows), never from stdin. Without a terminal
they fail. The only supported non-interactive route is
`age-plugin-batchpass`, shipped since age 1.3. It reads the passphrase from
`AGE_PASSPHRASE` or the `AGE_PASSPHRASE_FD` file descriptor (`age -j batchpass`).
Its own documentation discourages it, and it requires users to have age ≥ 1.3
including the plugin binary on `PATH`.

**Options considered:**

| Option | Pros | Cons |
| --- | --- | --- |
| age CLI + batchpass via `AGE_PASSPHRASE_FD` | official binary | needs age ≥ 1.3 plus the plugin on every machine; extra fd plumbing on Windows; discouraged by its author |
| Go helper using `filippo.io/age` | official Go library | one binary per OS/arch to build, sign and ship; another process boundary for the password |
| **`age-encryption` (typage) in-process** | official TypeScript implementation by age's author; no binaries, no process boundary; works the same on all platforms | scrypt in JavaScript is synchronous and takes ~1.5 s |

**Decision:** use `age-encryption`, the third option. It meets the brief's
underlying requirements (standard format, official implementation, no custom
crypto, no password in arguments) with the fewest moving parts. To keep the
extension host responsive despite the synchronous scrypt, all crypto runs in a
`worker_thread` (`src/cryptoWorker.ts`). The password reaches the worker via
`postMessage`, in memory only. The `ageMarkdown.agePath` setting from the
original brief is therefore not needed.

Compatibility is tested in both directions against the official age CLI
(`test/crypto.test.ts`): binary and armored files, empty files, Unicode, a 5 MB
document, wrong password, damaged files and key-encrypted files.

Known difference: typage refuses scrypt work factors above 20. The age CLI
encrypts with 18 and accepts up to 22 when decrypting.

## 2. Editable FileSystemProvider

A `FileSystemProvider` registered for the `age-md` scheme is fully editable.
The URI path is the real path of the encrypted file, so
`age-md:/home/me/notes/a.md.age` maps to `/home/me/notes/a.md.age`.

- `stat` reports the real file's `mtime`. VS Code's own conflict detection
  therefore works: it shows the "file is newer" dialog with Compare/Overwrite.
  The store adds a SHA-256 snapshot check immediately before replacing the
  file, which also covers coarse mtime resolution and races.
- `watch` forwards a `FileSystemWatcher` on the real file. Clean documents
  reload after external changes; VS Code skips the re-read after our own saves
  because the etag (mtime + size) matches.
- `writeFile` on a missing path asks for a new password and creates the file.
  This covers "Save As" inside `age-md:` and files deleted while open.
- Registering the provider does not change how `*.md.age` files open from the
  Explorer. The extension therefore offers an Explorer context-menu entry, an
  editor-title button for a raw `*.md.age` tab, and a command. It does not
  hijack the default open behaviour.

Verified in a real VS Code by `npm run test:integration`.

## 3. Markdown language mode

`contributes.languages` associates the `*.md.age` file name pattern with
`markdown`. As a fallback, the extension calls `setTextDocumentLanguage` for
`age-md:` documents. That call closes and reopens the document; the
password-forgetting logic on close accounts for this.

## 4. VS Code backups and history

Checked in the VS Code source code
(`workingCopyBackupTracker.ts`, `workingCopyHistoryTracker.ts`,
`windowsMainService.ts`) and reproduced by `npm run test:backup-probe`, which
installs a small probe extension into a normal VS Code instance:

| Mechanism | Behaviour for `age-md:` documents |
| --- | --- |
| Hot exit / crash-recovery backups | **Plaintext written to `<user data>/Backups/<workspace>/age-md/<hash>`** 1 s (2 s with short auto-save) after each change, for every scheme. Deleted after save. Kept on quit with `files.hotExit` enabled (default) and restored on restart; left behind after a crash. Extensions have no API to disable it. |
| Local History | Not recorded. `shouldTrackHistory` accepts only the default file scheme, `vscode-userData` and `inMemory`. |
| Workspace storage | No plaintext found after saving (view state only). |
| Undo stack | In memory only. |

Note: an extension development host (F5, `@vscode/test-electron`) keeps
backups in memory only, because `windowsMainService.ts` registers no backup
path when `extensionDevelopmentPath` is set. Testing this behaviour from the
regular integration tests would wrongly suggest that there are no backups.

**Consequence:** with the standard editor, plaintext on disk cannot be
guaranteed not to happen. The README states this prominently instead of
claiming protection. The only way to control backups would be a
`CustomEditorProvider` with its own `backupCustomDocument`, which requires a
webview editor and was out of scope.

## 5. Atomic saving across platforms

`src/atomicWrite.ts`:

1. Resolve symlinks, so the link's target is replaced and the link survives.
2. Create `.<name>.<random>.tmp` in the same directory with `O_EXCL` and the
   original file mode.
3. Write the ciphertext, then `fsync`.
4. `rename` over the target. This is atomic on POSIX. On Windows, Node uses
   `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`. Transient `EPERM`/`EBUSY`/`EACCES`
   errors (antivirus, indexers, sync clients) are retried with backoff.
5. `fsync` the directory (POSIX only, best effort).

On any error the temporary file is removed and the original stays untouched.
New files are created with `O_EXCL` and never overwrite anything. The
temporary file can be left behind only if the process dies between steps 2
and 4, and it contains only ciphertext.

Not preserved on replace: hard links, ownership by another user, extended
attributes and ACLs. This is the usual trade-off of atomic replacement.
