import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AgeError } from '../src/ageCrypto';
import { PasswordCache } from '../src/passwordCache';
import { AgeFileStore, CancelledError, ConflictError, StoreUi } from '../src/store';
import { AGE_BIN, ageCli, newCrypto, readAllFiles, tempDir } from './helpers';

const PASSWORD = 'heslo-ěščř-🙂';
const SECRET = 'TAJNÝ OBSAH 7f3a9c 🔐';
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const crypto = newCrypto();
afterAll(() => crypto.dispose());

class FakeUi implements StoreUi {
	answers: (string | undefined)[] = [];
	prompts: boolean[] = [];
	overwrite = false;
	overwriteAsked = 0;

	async promptPassword(_file: string, retry: boolean) {
		this.prompts.push(retry);
		return this.answers.shift();
	}

	newPasswords: (string | undefined)[] = [];

	async promptNewPassword() {
		return this.newPasswords.shift();
	}

	async confirmOverwrite() {
		this.overwriteAsked++;
		return this.overwrite;
	}
}

let dir: string;
let ui: FakeUi;
let passwords: PasswordCache;
let share: boolean;
let store: AgeFileStore;

beforeEach(() => {
	dir = tempDir();
	ui = new FakeUi();
	share = true;
	passwords = new PasswordCache(() => share);
	store = new AgeFileStore(crypto, passwords, ui);
});

async function encryptedFile(name: string, text: string, password = PASSWORD): Promise<string> {
	const file = path.join(dir, name);
	fs.writeFileSync(file, await crypto.encrypt(enc(text), password));
	return file;
}

async function decryptFile(file: string, password = PASSWORD): Promise<string> {
	return dec((await crypto.decrypt(fs.readFileSync(file), password)).plaintext);
}

function expectNoPlaintextOnDisk(...needles: string[]) {
	for (const content of readAllFiles(dir)) {
		for (const needle of needles) {
			expect(content.includes(Buffer.from(needle))).toBe(false);
		}
	}
}

describe('reading', () => {
	it('prompts once and reuses the password', async () => {
		const file = await encryptedFile('a.md.age', SECRET);
		ui.answers = [PASSWORD];
		expect(dec(await store.read(file))).toBe(SECRET);
		expect(dec(await store.read(file))).toBe(SECRET);
		expect(ui.prompts).toEqual([false]);
	});

	it('offers another attempt after a wrong password', async () => {
		const file = await encryptedFile('a.md.age', SECRET);
		ui.answers = ['wrong', PASSWORD];
		expect(dec(await store.read(file))).toBe(SECRET);
		expect(ui.prompts).toEqual([false, true]);
	});

	it('gives up after a limited number of attempts', async () => {
		const file = await encryptedFile('a.md.age', SECRET);
		ui.answers = ['a', 'b', 'c', PASSWORD];
		await expect(store.read(file)).rejects.toMatchObject({ code: 'wrong-password' });
		expect(ui.prompts).toHaveLength(3);
	});

	it('stops when the prompt is cancelled', async () => {
		const file = await encryptedFile('a.md.age', SECRET);
		ui.answers = [undefined];
		await expect(store.read(file)).rejects.toBeInstanceOf(CancelledError);
	});

	it('does not prompt for a damaged file more than once', async () => {
		const file = path.join(dir, 'bad.md.age');
		fs.writeFileSync(file, 'age-encryption.org/v1\ngarbage');
		ui.answers = [PASSWORD, PASSWORD];
		await expect(store.read(file)).rejects.toBeInstanceOf(AgeError);
		expect(ui.prompts).toHaveLength(1);
	});

	it('shares the session password between files', async () => {
		const a = await encryptedFile('a.md.age', 'A');
		const b = await encryptedFile('b.md.age', 'B');
		ui.answers = [PASSWORD];
		const [ra, rb] = await Promise.all([store.read(a), store.read(b)]);
		expect([dec(ra), dec(rb)]).toEqual(['A', 'B']);
		expect(ui.prompts).toHaveLength(1);
	});

	it('does not share passwords when caching is disabled', async () => {
		share = false;
		const a = await encryptedFile('a.md.age', 'A');
		const b = await encryptedFile('b.md.age', 'B');
		ui.answers = [PASSWORD, PASSWORD];
		await store.read(a);
		await store.read(b);
		expect(ui.prompts).toHaveLength(2);
	});

	it('handles files with different passwords', async () => {
		const a = await encryptedFile('a.md.age', 'A', 'first');
		const b = await encryptedFile('b.md.age', 'B', 'second');
		ui.answers = ['first', 'second'];
		expect(dec(await store.read(a))).toBe('A');
		expect(dec(await store.read(b))).toBe('B');
		// The shared "first" password was tried for b and failed, so the prompt says "retry".
		expect(ui.prompts).toEqual([false, true]);
	});
});

describe('writing', () => {
	it('re-encrypts with the same password without writing plaintext', async () => {
		const file = await encryptedFile('a.md.age', 'old');
		ui.answers = [PASSWORD];
		await store.read(file);
		await store.write(file, enc(SECRET));
		expect(await decryptFile(file)).toBe(SECRET);
		expect(fs.readdirSync(dir)).toEqual(['a.md.age']);
		expectNoPlaintextOnDisk(SECRET, PASSWORD);
		expect(ui.prompts).toHaveLength(1);
	});

	it.skipIf(!AGE_BIN)('writes files the age CLI can decrypt, also after reopening', async () => {
		const file = path.join(dir, 'cli.md.age');
		fs.writeFileSync(file, ageCli(['-e'], 'z CLI', PASSWORD));
		ui.answers = [PASSWORD];
		expect(dec(await store.read(file))).toBe('z CLI');
		await store.write(file, enc(SECRET));
		expect(ageCli(['-d'], fs.readFileSync(file), PASSWORD).toString()).toBe(SECRET);

		const reopened = new AgeFileStore(crypto, new PasswordCache(() => true), Object.assign(new FakeUi(), { answers: [PASSWORD] }));
		expect(dec(await reopened.read(file))).toBe(SECRET);
	});

	it.skipIf(!AGE_BIN)('keeps the ASCII armor of armored files', async () => {
		const file = path.join(dir, 'armored.md.age');
		fs.writeFileSync(file, ageCli(['-e', '-a'], 'old', PASSWORD));
		ui.answers = [PASSWORD];
		await store.read(file);
		await store.write(file, enc(SECRET));
		expect(fs.readFileSync(file, 'utf8')).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----/);
		expect(ageCli(['-d'], fs.readFileSync(file), PASSWORD).toString()).toBe(SECRET);
	});

	it('refuses to overwrite external changes unless confirmed', async () => {
		const file = await encryptedFile('a.md.age', 'old');
		ui.answers = [PASSWORD];
		await store.read(file);
		const external = await crypto.encrypt(enc('changed elsewhere'), PASSWORD);
		fs.writeFileSync(file, external);

		await expect(store.write(file, enc(SECRET))).rejects.toBeInstanceOf(ConflictError);
		expect(ui.overwriteAsked).toBe(1);
		expect(Buffer.from(fs.readFileSync(file)).equals(Buffer.from(external))).toBe(true);

		ui.overwrite = true;
		await store.write(file, enc(SECRET));
		expect(await decryptFile(file)).toBe(SECRET);
	});

	it('does not report a conflict for its own previous save', async () => {
		const file = await encryptedFile('a.md.age', 'old');
		ui.answers = [PASSWORD];
		await store.read(file);
		await store.write(file, enc('one'));
		await store.write(file, enc('two'));
		expect(ui.overwriteAsked).toBe(0);
		expect(await decryptFile(file)).toBe('two');
	});

	it('asks for and verifies the password again after passwords were forgotten', async () => {
		const file = await encryptedFile('a.md.age', 'old');
		ui.answers = [PASSWORD];
		await store.read(file);
		passwords.clear();

		ui.answers = ['typo', 'typo2', 'typo3'];
		await expect(store.write(file, enc(SECRET))).rejects.toMatchObject({ code: 'wrong-password' });
		expect(await decryptFile(file)).toBe('old');

		ui.answers = [PASSWORD];
		await store.write(file, enc(SECRET));
		expect(await decryptFile(file)).toBe(SECRET);
	});

	it('keeps the original file when encryption fails', async () => {
		const file = await encryptedFile('a.md.age', 'old');
		const failing = newCrypto();
		failing.encrypt = async () => {
			throw new AgeError('internal', 'Encryption failed (test).');
		};
		const s = new AgeFileStore(failing, passwords, Object.assign(new FakeUi(), { answers: [PASSWORD] }));
		await s.read(file);
		await expect(s.write(file, enc(SECRET))).rejects.toThrow('Encryption failed');
		expect(await decryptFile(file)).toBe('old');
		expect(fs.readdirSync(dir)).toEqual(['a.md.age']);
		failing.dispose();
	});

	it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('keeps the original file when writing fails', async () => {
		const file = await encryptedFile('a.md.age', 'old');
		ui.answers = [PASSWORD];
		await store.read(file);
		fs.chmodSync(dir, 0o500);
		try {
			await expect(store.write(file, enc(SECRET))).rejects.toMatchObject({ code: 'EACCES' });
		} finally {
			fs.chmodSync(dir, 0o700);
		}
		expect(await decryptFile(file)).toBe('old');
		expect(fs.readdirSync(dir)).toEqual(['a.md.age']);
	});

	it('recreates a file deleted while open, with the same password', async () => {
		const file = await encryptedFile('a.md.age', 'old');
		ui.answers = [PASSWORD];
		await store.read(file);
		fs.rmSync(file);
		await store.write(file, enc(SECRET));
		expect(await decryptFile(file)).toBe(SECRET);
		expect(ui.prompts).toHaveLength(1);
	});

	it('asks for a new password when saving to a new path ("Save As")', async () => {
		const target = path.join(dir, 'copy.md.age');
		ui.newPasswords = ['copy-password'];
		await store.write(target, enc(SECRET));
		expect(await decryptFile(target, 'copy-password')).toBe(SECRET);
		expectNoPlaintextOnDisk(SECRET, 'copy-password');
	});

	it('creates nothing when the new password prompt is cancelled', async () => {
		const target = path.join(dir, 'copy.md.age');
		ui.newPasswords = [undefined];
		await expect(store.write(target, enc(SECRET))).rejects.toBeInstanceOf(CancelledError);
		expect(fs.readdirSync(dir)).toEqual([]);
	});
});

describe('creating', () => {
	it.skipIf(!AGE_BIN)('creates an empty encrypted file that age can decrypt', async () => {
		const file = path.join(dir, 'new.md.age');
		await store.create(file, new Uint8Array(), PASSWORD);
		expect(ageCli(['-d'], fs.readFileSync(file), PASSWORD).length).toBe(0);
		// The password is remembered for the first save.
		await store.write(file, enc(SECRET));
		expect(await decryptFile(file)).toBe(SECRET);
		expect(ui.prompts).toHaveLength(0);
		expectNoPlaintextOnDisk(SECRET, PASSWORD);
	});

	it('never overwrites an existing file', async () => {
		const file = await encryptedFile('a.md.age', 'precious');
		await expect(store.create(file, new Uint8Array(), 'other')).rejects.toMatchObject({ code: 'EEXIST' });
		expect(await decryptFile(file)).toBe('precious');
	});
});
