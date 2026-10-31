import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileExclusive, replaceFileAtomic } from '../src/atomicWrite';
import { tempDir } from './helpers';

const canTestPermissions = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('replaceFileAtomic', () => {
	it('replaces the file and leaves no temporary files behind', async () => {
		const dir = tempDir();
		const file = path.join(dir, 'a.md.age');
		fs.writeFileSync(file, 'old');
		await replaceFileAtomic(file, Buffer.from('new'));
		expect(fs.readFileSync(file, 'utf8')).toBe('new');
		expect(fs.readdirSync(dir)).toEqual(['a.md.age']);
	});

	it.skipIf(process.platform === 'win32')('preserves the file mode', async () => {
		const dir = tempDir();
		const file = path.join(dir, 'a.md.age');
		fs.writeFileSync(file, 'old', { mode: 0o600 });
		fs.chmodSync(file, 0o600);
		await replaceFileAtomic(file, Buffer.from('new'));
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});

	it.skipIf(process.platform === 'win32')('writes through symlinks', async () => {
		const dir = tempDir();
		const real = path.join(dir, 'real.md.age');
		const link = path.join(dir, 'link.md.age');
		fs.writeFileSync(real, 'old');
		fs.symlinkSync(real, link);
		await replaceFileAtomic(link, Buffer.from('new'));
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
		expect(fs.readFileSync(real, 'utf8')).toBe('new');
	});

	it.skipIf(!canTestPermissions)('keeps the original file when writing fails', async () => {
		const dir = tempDir();
		const file = path.join(dir, 'a.md.age');
		fs.writeFileSync(file, 'old');
		fs.chmodSync(dir, 0o500);
		try {
			await expect(replaceFileAtomic(file, Buffer.from('new'))).rejects.toMatchObject({ code: 'EACCES' });
		} finally {
			fs.chmodSync(dir, 0o700);
		}
		expect(fs.readFileSync(file, 'utf8')).toBe('old');
		expect(fs.readdirSync(dir)).toEqual(['a.md.age']);
	});

	it('fails when the target does not exist', async () => {
		const dir = tempDir();
		await expect(replaceFileAtomic(path.join(dir, 'missing'), Buffer.from('x'))).rejects.toMatchObject({ code: 'ENOENT' });
		expect(fs.readdirSync(dir)).toEqual([]);
	});
});

describe('createFileExclusive', () => {
	it('creates a new file', async () => {
		const file = path.join(tempDir(), 'n.md.age');
		await createFileExclusive(file, Buffer.from('data'));
		expect(fs.readFileSync(file, 'utf8')).toBe('data');
	});

	it('never overwrites an existing file', async () => {
		const file = path.join(tempDir(), 'n.md.age');
		fs.writeFileSync(file, 'precious');
		await expect(createFileExclusive(file, Buffer.from('data'))).rejects.toMatchObject({ code: 'EEXIST' });
		expect(fs.readFileSync(file, 'utf8')).toBe('precious');
	});
});
