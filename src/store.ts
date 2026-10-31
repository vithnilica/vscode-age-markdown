import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { AgeCrypto, AgeError, Decrypted } from './ageCrypto';
import { createFileExclusive, replaceFileAtomic } from './atomicWrite';
import { PasswordCache } from './passwordCache';

export const MAX_FILE_SIZE = 64 * 1024 * 1024;
export const MAX_PASSWORD_ATTEMPTS = 3;

export interface StoreUi {
	/** Asks for the password of an existing file; `undefined` means cancelled. */
	promptPassword(filePath: string, retry: boolean): Promise<string | undefined>;
	/** Asks for a new password (entered twice) for a file being created; `undefined` means cancelled. */
	promptNewPassword(filePath: string): Promise<string | undefined>;
	/** Asks whether to overwrite a file that changed on disk since it was read. */
	confirmOverwrite(filePath: string): Promise<boolean>;
}

export class CancelledError extends Error {
	constructor() {
		super('Password entry was cancelled.');
		this.name = 'CancelledError';
	}
}

export class ConflictError extends Error {
	constructor() {
		super('The file was changed on disk. Save was cancelled to avoid overwriting those changes.');
		this.name = 'ConflictError';
	}
}

/**
 * Reads and writes encrypted files on disk. Plaintext only ever exists in
 * memory: it is returned to the caller on read and encrypted before any write.
 */
export class AgeFileStore {
	// SHA-256 of the ciphertext last read or written per file, for conflict detection.
	private readonly snapshots = new Map<string, string>();
	private readonly armored = new Map<string, boolean>();
	// One queue for all operations: serializes password prompts (VS Code shows
	// one input box at a time) and lets a password entered for one file be
	// reused for the next one waiting.
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly crypto: AgeCrypto,
		private readonly passwords: PasswordCache,
		private readonly ui: StoreUi,
	) {}

	read(filePath: string): Promise<Uint8Array> {
		return this.serialize(async () => {
			const ciphertext = await readCiphertext(filePath);
			const { plaintext, armored } = await this.unlock(filePath, ciphertext);
			this.snapshots.set(filePath, digest(ciphertext));
			this.armored.set(filePath, armored);
			return plaintext;
		});
	}

	/**
	 * Re-encrypts an existing file with the password it was opened with. A
	 * missing file (deleted while open, or a "Save As" target) is created anew.
	 */
	write(filePath: string, plaintext: Uint8Array): Promise<void> {
		return this.serialize(async () => {
			if (!(await exists(filePath))) {
				await this.recreate(filePath, plaintext);
				return;
			}

			let password = this.passwords.get(filePath);
			if (password === undefined) {
				// Passwords were forgotten while the document stayed open. Ask
				// again and verify it against the file so a typo cannot
				// silently re-encrypt the notes with an unknown password.
				await this.unlock(filePath, await readCiphertext(filePath));
				password = this.passwords.get(filePath)!;
			}
			const ciphertext = await this.crypto.encrypt(plaintext, password, this.armored.get(filePath) ?? false);

			const known = this.snapshots.get(filePath);
			const onDisk = digest(await readCiphertext(filePath));
			if (known !== undefined && onDisk !== known && !(await this.ui.confirmOverwrite(filePath))) {
				throw new ConflictError();
			}

			await replaceFileAtomic(filePath, ciphertext);
			this.snapshots.set(filePath, digest(ciphertext));
		});
	}

	/** Creates a new encrypted file; never overwrites an existing one. */
	create(filePath: string, plaintext: Uint8Array, password: string): Promise<void> {
		return this.serialize(() => this.doCreate(filePath, plaintext, password));
	}

	private async recreate(filePath: string, plaintext: Uint8Array): Promise<void> {
		const password = this.passwords.get(filePath) ?? (await this.ui.promptNewPassword(filePath));
		if (password === undefined) {
			throw new CancelledError();
		}
		await this.doCreate(filePath, plaintext, password);
	}

	private async doCreate(filePath: string, plaintext: Uint8Array, password: string): Promise<void> {
		const armored = this.armored.get(filePath) ?? false;
		const ciphertext = await this.crypto.encrypt(plaintext, password, armored);
		await createFileExclusive(filePath, ciphertext);
		this.passwords.remember(filePath, password);
		this.snapshots.set(filePath, digest(ciphertext));
		this.armored.set(filePath, armored);
	}

	forget(filePath: string): void {
		this.snapshots.delete(filePath);
		this.armored.delete(filePath);
	}

	private async unlock(filePath: string, ciphertext: Uint8Array): Promise<Decrypted> {
		const candidates = this.passwords.candidates(filePath);
		for (const password of candidates) {
			const result = await this.tryDecrypt(ciphertext, password);
			if (result) {
				this.passwords.remember(filePath, password);
				return result;
			}
		}

		let retry = candidates.length > 0;
		for (let attempt = 0; attempt < MAX_PASSWORD_ATTEMPTS; attempt++) {
			const password = await this.ui.promptPassword(filePath, retry);
			if (password === undefined) {
				throw new CancelledError();
			}
			const result = await this.tryDecrypt(ciphertext, password);
			if (result) {
				this.passwords.remember(filePath, password);
				return result;
			}
			retry = true;
		}
		throw new AgeError('wrong-password', `Wrong password (${MAX_PASSWORD_ATTEMPTS} attempts).`);
	}

	private async tryDecrypt(ciphertext: Uint8Array, password: string): Promise<Decrypted | undefined> {
		try {
			return await this.crypto.decrypt(ciphertext, password);
		} catch (err) {
			if (err instanceof AgeError && err.code === 'wrong-password') {
				return undefined;
			}
			throw err;
		}
	}

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}
}

export async function readCiphertext(filePath: string): Promise<Uint8Array> {
	const stat = await fs.stat(filePath);
	if (!stat.isFile()) {
		throw Object.assign(new Error(`Not a file: ${filePath}`), { code: 'EISDIR' });
	}
	if (stat.size > MAX_FILE_SIZE) {
		throw new AgeError('too-large', `The file is larger than ${MAX_FILE_SIZE / 1024 / 1024} MiB.`);
	}
	return fs.readFile(filePath);
}

async function exists(filePath: string): Promise<boolean> {
	return fs.stat(filePath).then(() => true, () => false);
}

function digest(data: Uint8Array): string {
	return createHash('sha256').update(data).digest('hex');
}
