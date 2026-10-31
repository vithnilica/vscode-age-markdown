import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// Static checks over the extension sources that back the security promises in
// the README: no child processes (so no passwords in process arguments or
// environment), no logging, no network access, no persistent secret storage.

const srcDir = path.join(__dirname, '..', 'src');
const sources = fs.readdirSync(srcDir).filter(f => f.endsWith('.ts'))
	.map(f => ({ name: f, code: fs.readFileSync(path.join(srcDir, f), 'utf8') }));

describe('extension sources', () => {
	it.each([
		['child processes', /child_process|\bspawn\(|\bexec\(/],
		['console logging', /\bconsole\./],
		['output channels / log files', /createOutputChannel|LogOutputChannel/],
		['network access', /\bfetch\(|node:https?|node:net|node:dgram|XMLHttpRequest|WebSocket/],
		['persistent secret or state storage', /\bsecrets\b|globalState|workspaceState|SecretStorage/],
		['telemetry', /telemetry/i],
	])('do not use %s', (_label, pattern) => {
		const offenders = sources.filter(s => pattern.test(s.code)).map(s => s.name);
		expect(offenders).toEqual([]);
	});

	it('write to disk only through the atomic ciphertext writers', () => {
		const writers = sources.filter(s => /\bwriteFile\(|fs\.open\(|createWriteStream|appendFile/.test(s.code)).map(s => s.name);
		// provider.ts only implements the FileSystemProvider.writeFile method and delegates to the store.
		expect(writers.sort()).toEqual(['atomicWrite.ts', 'provider.ts']);
		const provider = sources.find(s => s.name === 'provider.ts')!.code;
		expect(provider).not.toMatch(/fs\.(writeFile|open|appendFile)/);
	});
});
