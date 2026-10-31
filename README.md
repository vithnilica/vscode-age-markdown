# Age Markdown

Edit [age](https://age-encryption.org)-encrypted Markdown files directly in VS Code.

Open a `*.md.age` file, enter its password, and edit it in VS Code's regular
Markdown editor with syntax highlighting, preview, undo/redo, find/replace and
your usual Markdown extensions. When you press `Ctrl+S` / `Cmd+S`, the file is
encrypted again and written back atomically. The files use the standard age
format, so you can always decrypt them with the `age` command-line tool and
nothing else.

> **Read [Security and limitations](#security-and-limitations) before using it
> for sensitive notes.** In short: the extension itself never writes plaintext
> to disk, but **VS Code backs up unsaved changes in plaintext** and other
> extensions (including AI assistants) can read open documents.

## Features

- Opens password-protected age files, including files created outside VS Code
  with `age -p` (binary or ASCII-armored).
- Uses the standard VS Code editor through a virtual file system (`age-md:`).
  There is no custom editor and no webview.
- Encrypts on save and atomically replaces the file. If anything fails, the
  original stays untouched.
- Detects changes made on disk and never silently overwrites them.
- Creates new encrypted files without an unencrypted intermediate file.
- Keeps passwords in memory only.
- No telemetry and no network access. The extension starts no child processes.

## Requirements

- VS Code 1.90 or newer (desktop).
- No external `age` binary is needed. Encryption uses
  [`age-encryption`](https://github.com/FiloSottile/typage), the official
  TypeScript implementation of age by age's author. Installing the `age` CLI is
  still recommended, so you can access your notes without VS Code.

## Installation

From a `.vsix` file:

```sh
code --install-extension age-markdown-0.1.0.vsix
```

From source:

```sh
git clone https://github.com/vithnilica/vscode-age-markdown
cd vscode-age-markdown
npm install
npm run package          # produces age-markdown-<version>.vsix
code --install-extension age-markdown-*.vsix
```

### Installing the age CLI (optional, recommended)

| Platform | Command |
| --- | --- |
| Debian / Ubuntu | `sudo apt install age` |
| Fedora | `sudo dnf install age` |
| Arch Linux | `sudo pacman -S age` |
| macOS (Homebrew) | `brew install age` |
| Windows (winget) | `winget install --id FiloSottile.age` |
| Windows (Scoop) | `scoop install age` |
| Any platform with Go | `go install filippo.io/age/cmd/...@latest` |

You can also download binaries from the
[age releases page](https://github.com/FiloSottile/age/releases).

## Usage

### Create an encrypted file

1. Run **Age Markdown: New Encrypted Markdown File** from the Command Palette.
2. Choose the location and name. The `.md.age` extension is added
   automatically.
3. Enter the password twice.

The extension writes a valid, empty age file and opens it. It refuses to
overwrite an existing file.

### Open an encrypted file

- In the Explorer, right-click a `*.age` file and choose **Open Encrypted File**.
- Or run **Age Markdown: Open Encrypted File** from the Command Palette.
- If you opened a `*.md.age` file the normal way (VS Code shows it as a binary
  file), click the **Open Encrypted File** button in the editor title bar or run
  the command. The raw tab is replaced by the decrypted document.

The decrypted document opens as Markdown in the standard editor. Its URI uses
the `age-md:` scheme and points to the real path of the encrypted file.

### Edit and save

Edit as usual and save with `Ctrl+S` / `Cmd+S`. On every save the extension:

1. Encrypts the content in memory with the password the file was opened with.
2. Checks that the file on disk has not been changed by someone else since it
   was read. If it has, it asks before overwriting anything.
3. Writes the ciphertext to a temporary file next to the original, flushes it to
   disk and atomically renames it over the original.

Saving takes a moment (about 1–2 s) because age's password-based encryption
uses the scrypt key derivation function, which is intentionally slow.

**Save As…** inside the `age-md:` file system asks for a password and creates a
new encrypted file. If you switch the dialog to a local path (*Show Local*),
VS Code writes an **unencrypted** copy there.

### Passwords

- You are asked for the password the first time you open a file. After three
  wrong attempts the extension gives up.
- With `ageMarkdown.cachePassword` enabled (the default), the last password
  that worked is also tried for other files during the session.
- Passwords live only in the extension's memory. They are never written to
  disk, settings, logs or VS Code's SecretStorage, and never passed to another
  process.
- **Age Markdown: Forget Passwords** clears the password cache.
- **Age Markdown: Lock All** clears the password cache and closes all encrypted
  editors that have no unsaved changes. Editors with unsaved changes stay open:
  save or revert them, then close them.

Forgetting passwords does not remove decrypted text that is already open: the
editor, its undo history and VS Code's memory still hold it. To lock your notes,
close the editors.

### Changing the password

A dedicated command is planned. Until then, change the password without any
plaintext on disk like this:

1. Open the file and run **File: Save As…**. Stay in the `age-md:` file system,
   pick a new name and enter the new password.
2. Close both editors and replace the old file with the new one.

Remember that old versions in Git history remain encrypted with the old
password (see below).

### Decrypting without VS Code

```sh
# Print the plaintext to the terminal
age -d notes.md.age

# Decrypt to a file (this creates plaintext on disk!)
age -d -o notes.md notes.md.age

# Encrypt an existing Markdown file with a password
age -p -o notes.md.age notes.md
```

age asks for the password interactively. For scripts, age 1.3+ includes
`age-plugin-batchpass`, which reads the password from the `AGE_PASSPHRASE_FD`
file descriptor or the `AGE_PASSPHRASE` environment variable:
`age -d -j batchpass notes.md.age`.

## Using with Git

The extension only ever changes the encrypted files themselves, so you can keep
your notes in a Git repository:

```text
my-notes/
├── README.md
├── personal.md.age
├── infrastructure.md.age
└── projects.md.age
```

Things to keep in mind:

- Git does not see changes in the Markdown content. Every save produces
  completely different ciphertext, even for a one-character change, so diffs
  and merges of `*.md.age` files are not meaningful. Resolve conflicts by
  decrypting both versions and merging them by hand.
- Git history keeps every encrypted version forever.
- Changing the password does not protect old versions. They can still be
  decrypted with the old password.
- File names, sizes and modification times are not encrypted.

It helps to tell Git that these files are binary:

```gitattributes
# .gitattributes
*.age binary
```

To see plaintext diffs in your terminal, you can opt in to a textconv driver.
Git then runs `age -d` and asks for the password for each version it shows.
Keep `cachetextconv` disabled, otherwise Git stores the decrypted text in the
repository:

```sh
git config diff.age.textconv "age -d"
echo '*.md.age diff=age' >> .gitattributes
```

## Security and limitations

For a detailed threat model, risk assessment and recommendations, see
[docs/SECURITY-RISKS.md](docs/SECURITY-RISKS.md).

### What the extension guarantees

- It never writes plaintext to disk. Temporary files contain only ciphertext,
  are created next to the target and are removed on failure. The original file
  is replaced only after the new ciphertext is completely written and flushed.
- Passwords stay in memory. They never appear in process arguments, environment
  variables, logs, settings or VS Code's SecretStorage.
- It has no telemetry and no network access, starts no child processes and
  offers no API to other extensions.
- It uses the standard age format through the official implementation. There
  is no custom cryptography.

### What VS Code does with decrypted documents

The decrypted text is an ordinary VS Code text document, so VS Code features
apply to it. The following was checked in VS Code's source code and
reproduced with VS Code 1.144 by `npm run test:backup-probe`:

- **Hot exit and crash-recovery backups: plaintext on disk.** About 1–2 s after
  you change a document, VS Code writes a backup of the unsaved content in
  plaintext to its user data directory:
  - Linux: `~/.config/Code/Backups/`
  - macOS: `~/Library/Application Support/Code/Backups/`
  - Windows: `%APPDATA%\Code\Backups\`

  The backup is deleted when you save. With the default
  `"files.hotExit": "onExit"`, quitting VS Code with unsaved changes **keeps the
  plaintext backup** and restores it on the next start. After a crash the
  backup also stays. Extensions cannot turn this off. To reduce the exposure:
  - Save often.
  - Optionally, set `"files.hotExit": "off"`. VS Code then asks you to save on
    exit and discards the backups. They are still written while you edit, and
    they survive a crash. The setting is application-wide, so it disables hot
    exit for all files; the extension leaves this decision to you.
  - Use full-disk encryption.
- **Local History: nothing stored.** VS Code's Local History records only local
  files, so it keeps no copies of `age-md:` documents.
- No other copies were found: after saving, the test found no plaintext
  anywhere in VS Code's user data directory, including workspace storage.

### Other extensions and AI assistants

Any installed extension can read open documents through the standard VS Code
API. That includes AI assistants, spell checkers and sync tools, and they may
send the text elsewhere. **This extension provides no isolation from other
extensions.** For sensitive notes, consider a separate
[VS Code profile](https://code.visualstudio.com/docs/editor/profiles) with only
the extensions you trust, for example
`code --profile "Encrypted notes" ~/my-notes`.

### Other limitations

- Decrypted text and passwords stay in process memory until the editors are
  closed and memory is reclaimed. JavaScript strings cannot be wiped, so
  **Lock All** and **Forget Passwords** are not secure erasure. Memory may also
  end up in swap, hibernation images or crash dumps.
- Copying to the clipboard, **Save As…** to a local path, printing and similar
  actions can expose the plaintext.
- With Remote Development (SSH, WSL, containers), the extension runs on the
  remote machine, so the password and plaintext live there.
- Only password-encrypted (`age -p`) files are supported, not files encrypted to
  age or SSH keys. The scrypt work factor of a file can be at most 20 (`age`
  uses 18 by default).
- age's password mode is only as strong as your password. Use a long, random
  passphrase.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `ageMarkdown.cachePassword` | `true` | Reuse the last working password for other files during the session. If disabled, each file asks for its own password and forgets it when its editor is closed. |

## Development

```sh
npm install
npm test                     # build + unit tests (uses the age CLI for compatibility tests if found)
npm run test:integration     # runs the extension in a real VS Code (Linux: xvfb-run -a npm run test:integration)
npm run test:backup-probe    # checks what VS Code writes to disk for unsaved documents
npm run package              # builds a .vsix
```

The compatibility tests look for `age` (version 1.3+ with `age-plugin-batchpass`)
on `PATH`, in `~/go/bin` or in `$AGE_BIN`, and are skipped if it is missing.

See [docs/TECHNICAL-NOTES.md](docs/TECHNICAL-NOTES.md) for the design decisions
and the results of the feasibility checks.

## License

[MIT](LICENSE)
