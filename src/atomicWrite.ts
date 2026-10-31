import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Only ciphertext is ever passed to these functions. Temporary files are
// created next to the target so that the final rename stays on one file system.

const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

/**
 * Atomically replaces an existing file: write a temporary file, flush it to
 * disk, then rename it over the target. On any failure the original file is
 * left untouched and the temporary file is removed.
 */
export async function replaceFileAtomic(target: string, data: Uint8Array): Promise<void> {
	// Write through symlinks instead of replacing the link with a regular file.
	const realTarget = await fs.realpath(target);
	const mode = (await fs.stat(realTarget)).mode & 0o7777;
	const dir = path.dirname(realTarget);
	const tmp = path.join(dir, `.${path.basename(realTarget)}.${randomBytes(6).toString('hex')}.tmp`);

	try {
		await writeAndSync(tmp, data, 'wx', mode);
		await renameWithRetry(tmp, realTarget);
	} catch (err) {
		await fs.rm(tmp, { force: true }).catch(() => undefined);
		throw err;
	}
	await syncDirectory(dir);
}

/** Creates a new file; fails with EEXIST instead of overwriting anything. */
export async function createFileExclusive(target: string, data: Uint8Array): Promise<void> {
	try {
		await writeAndSync(target, data, 'wx');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
			await fs.rm(target, { force: true }).catch(() => undefined);
		}
		throw err;
	}
	await syncDirectory(path.dirname(target));
}

async function writeAndSync(file: string, data: Uint8Array, flags: string, mode?: number): Promise<void> {
	const handle = await fs.open(file, flags, mode);
	try {
		await handle.writeFile(data);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function renameWithRetry(from: string, to: string): Promise<void> {
	// On Windows, replacing a file can fail transiently while another process
	// (antivirus, indexer, sync client) briefly holds it open.
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rename(from, to);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
			if (process.platform !== 'win32' || !transient || attempt >= RENAME_RETRY_DELAYS_MS.length) {
				throw err;
			}
			await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]));
		}
	}
}

async function syncDirectory(dir: string): Promise<void> {
	// Persist the directory entry after a rename. Not supported on Windows,
	// where NTFS journals metadata itself; best effort elsewhere.
	if (process.platform === 'win32') {
		return;
	}
	try {
		const handle = await fs.open(dir, 'r');
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {
		// Some file systems do not support fsync on directories.
	}
}
