import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgeError } from './ageCrypto';
import { SCHEME } from './paths';
import { AgeFileStore, CancelledError, ConflictError } from './store';

export function toAgeUri(fileUri: vscode.Uri): vscode.Uri {
	return fileUri.with({ scheme: SCHEME });
}

export function toFilePath(ageUri: vscode.Uri): string {
	return ageUri.with({ scheme: 'file', query: '', fragment: '' }).fsPath;
}

/**
 * Exposes `*.md.age` files as plaintext documents under the `age-md:` scheme.
 * The URI path is the real path of the encrypted file on disk.
 */
export class AgeFileSystemProvider implements vscode.FileSystemProvider {
	private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.emitter.event;

	constructor(private readonly store: AgeFileStore) {}

	watch(uri: vscode.Uri): vscode.Disposable {
		const file = toFilePath(uri);
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)),
		);
		const fire = (type: vscode.FileChangeType) => () => this.emitter.fire([{ type, uri }]);
		watcher.onDidChange(fire(vscode.FileChangeType.Changed));
		watcher.onDidCreate(fire(vscode.FileChangeType.Created));
		watcher.onDidDelete(fire(vscode.FileChangeType.Deleted));
		return watcher;
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const file = toFilePath(uri);
		try {
			const s = await fs.stat(file);
			const writable = await fs.access(file, fs.constants.W_OK).then(() => true, () => false);
			return {
				type: s.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
				ctime: s.ctimeMs,
				// The real file's mtime lets VS Code detect external changes and
				// save conflicts with its usual "file is newer" dialog.
				mtime: s.mtimeMs,
				size: s.size,
				permissions: writable ? undefined : vscode.FilePermission.Readonly,
			};
		} catch (err) {
			throw toFileSystemError(err, uri);
		}
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		try {
			const entries = await fs.readdir(toFilePath(uri), { withFileTypes: true });
			return entries
				.filter(e => e.isDirectory() || (e.isFile() && e.name.toLowerCase().endsWith('.age')))
				.map(e => [e.name, e.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File]);
		} catch (err) {
			throw toFileSystemError(err, uri);
		}
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		try {
			return await this.store.read(toFilePath(uri));
		} catch (err) {
			throw toFileSystemError(err, uri);
		}
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
		const file = toFilePath(uri);
		const exists = await fs.stat(file).then(() => true, () => false);
		if (!exists && !options.create) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		if (exists && !options.overwrite) {
			throw vscode.FileSystemError.FileExists(uri);
		}
		try {
			await this.store.write(file, content);
		} catch (err) {
			throw toFileSystemError(err, uri);
		}
	}

	createDirectory(): void {
		throw vscode.FileSystemError.NoPermissions('Not supported for encrypted files.');
	}

	delete(): void {
		throw vscode.FileSystemError.NoPermissions('Not supported for encrypted files.');
	}

	rename(): void {
		throw vscode.FileSystemError.NoPermissions('Not supported for encrypted files.');
	}
}

function toFileSystemError(err: unknown, uri: vscode.Uri): vscode.FileSystemError {
	if (err instanceof vscode.FileSystemError) {
		return err;
	}
	if (err instanceof AgeError || err instanceof CancelledError || err instanceof ConflictError) {
		return vscode.FileSystemError.NoPermissions(err.message);
	}
	switch ((err as NodeJS.ErrnoException).code) {
		case 'ENOENT':
			return vscode.FileSystemError.FileNotFound(uri);
		case 'EISDIR':
			return vscode.FileSystemError.FileIsADirectory(uri);
		case 'EEXIST':
			return vscode.FileSystemError.FileExists(uri);
		case 'EACCES':
		case 'EPERM':
			return vscode.FileSystemError.NoPermissions(uri);
	}
	// Errors from fs and the crypto worker carry paths at most, never content.
	return vscode.FileSystemError.Unavailable(err instanceof Error ? err.message : String(err));
}
