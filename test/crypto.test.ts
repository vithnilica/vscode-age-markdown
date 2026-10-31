import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { AgeError } from '../src/ageCrypto';
import { AGE_BIN, ageCli, newCrypto } from './helpers';

const PASSWORD = 'correct horse battery staple ěščř';
const TEXT = '# Poznámky\n\nPříliš žluťoučký kůň úpěl ďábelské ódy. 🐴🔐\n';
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const crypto = newCrypto();
afterAll(() => crypto.dispose());

describe('AgeCrypto', () => {
	it('round-trips Unicode text', async () => {
		const ct = await crypto.encrypt(enc(TEXT), PASSWORD);
		expect(dec(ct.subarray(0, 21))).toBe('age-encryption.org/v1');
		expect(Buffer.from(ct).includes(Buffer.from(TEXT))).toBe(false);
		const { plaintext, armored } = await crypto.decrypt(ct, PASSWORD);
		expect(dec(plaintext)).toBe(TEXT);
		expect(armored).toBe(false);
	});

	it('round-trips an empty document', async () => {
		const ct = await crypto.encrypt(new Uint8Array(), PASSWORD);
		expect((await crypto.decrypt(ct, PASSWORD)).plaintext.length).toBe(0);
	});

	it('rejects a wrong password', async () => {
		const ct = await crypto.encrypt(enc(TEXT), PASSWORD);
		await expect(crypto.decrypt(ct, 'wrong')).rejects.toMatchObject({ code: 'wrong-password' });
	});

	it('rejects damaged ciphertext', async () => {
		const ct = await crypto.encrypt(enc(TEXT), PASSWORD);
		ct[ct.length - 3] ^= 0x01;
		await expect(crypto.decrypt(ct, PASSWORD)).rejects.toMatchObject({ code: 'corrupted' });
	});

	it('rejects truncated ciphertext', async () => {
		const ct = await crypto.encrypt(enc(TEXT), PASSWORD);
		await expect(crypto.decrypt(ct.subarray(0, ct.length - 20), PASSWORD)).rejects.toBeInstanceOf(AgeError);
	});

	it('rejects data that is not an age file', async () => {
		await expect(crypto.decrypt(enc('# just markdown\n'), PASSWORD)).rejects.toMatchObject({ code: 'corrupted' });
	});

	it('does not put the password or plaintext into error messages', async () => {
		const ct = await crypto.encrypt(enc(TEXT), PASSWORD);
		const err = await crypto.decrypt(ct, 'secret-wrong-password').then(() => new Error('decrypted unexpectedly'), (e: Error) => e);
		expect(err.message).not.toContain('secret-wrong-password');
		const err2 = await crypto.decrypt(enc(TEXT), PASSWORD).then(() => new Error('decrypted unexpectedly'), (e: Error) => e);
		expect(err2.message).not.toContain('Poznámky');
		expect(err2.message).not.toContain(PASSWORD);
	});
});

describe.skipIf(!AGE_BIN)('compatibility with the age CLI', () => {
	it('decrypts a file encrypted by age', async () => {
		const ct = ageCli(['-e'], TEXT, PASSWORD);
		expect(dec((await crypto.decrypt(ct, PASSWORD)).plaintext)).toBe(TEXT);
	});

	it('produces files that age decrypts', async () => {
		const ct = await crypto.encrypt(enc(TEXT), PASSWORD);
		expect(ageCli(['-d'], ct, PASSWORD).toString()).toBe(TEXT);
	});

	it('handles empty documents both ways', async () => {
		expect((await crypto.decrypt(ageCli(['-e'], '', PASSWORD), PASSWORD)).plaintext.length).toBe(0);
		expect(ageCli(['-d'], await crypto.encrypt(new Uint8Array(), PASSWORD), PASSWORD).length).toBe(0);
	});

	it('handles ASCII-armored files both ways', async () => {
		const armoredCt = ageCli(['-e', '-a'], TEXT, PASSWORD);
		const { plaintext, armored } = await crypto.decrypt(armoredCt, PASSWORD);
		expect(dec(plaintext)).toBe(TEXT);
		expect(armored).toBe(true);

		const ours = await crypto.encrypt(enc(TEXT), PASSWORD, true);
		expect(dec(ours)).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----/);
		expect(ageCli(['-d'], ours, PASSWORD).toString()).toBe(TEXT);
	});

	it('handles a large Markdown file both ways', async () => {
		const big = `${'| sloupec | hodnota 🙂 |\n'.repeat(200_000)}konec\n`; // ~5 MB
		const fromCli = ageCli(['-e'], big, PASSWORD);
		expect(dec((await crypto.decrypt(fromCli, PASSWORD)).plaintext)).toBe(big);
		const ours = await crypto.encrypt(enc(big), PASSWORD);
		expect(ageCli(['-d'], ours, PASSWORD).toString()).toBe(big);
	});

	it('reports wrong password for an age file', async () => {
		const ct = ageCli(['-e'], TEXT, PASSWORD);
		await expect(crypto.decrypt(ct, 'nope')).rejects.toMatchObject({ code: 'wrong-password' });
	});

	it('explains that key-encrypted files are not supported', async () => {
		const keygen = AGE_BIN!.replace(/age(\.exe)?$/, 'age-keygen$1');
		const identity = spawnSync(keygen).stdout;
		const recipient = spawnSync(keygen, ['-y'], { input: identity }).stdout.toString().trim();
		const ct = ageCli(['-e', '-r', recipient], TEXT);
		await expect(crypto.decrypt(ct, PASSWORD)).rejects.toMatchObject({ code: 'not-passphrase-encrypted' });
	});
});
