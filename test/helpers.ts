import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';
import { AgeCrypto } from '../src/ageCrypto';

export const WORKER_PATH = path.join(__dirname, '..', 'dist', 'cryptoWorker.js');

export function newCrypto(): AgeCrypto {
	if (!fs.existsSync(WORKER_PATH)) {
		throw new Error('dist/cryptoWorker.js is missing, run "npm run build" first');
	}
	return new AgeCrypto(WORKER_PATH);
}

const tempDirs: string[] = [];
// Registered on the root suite of each test file that imports this module.
afterAll(() => tempDirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

export function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'age-md-test-'));
	tempDirs.push(dir);
	return dir;
}

/**
 * The official age CLI (>= 1.3, with age-plugin-batchpass next to it), used as
 * the reference implementation. Set AGE_BIN to point at a specific binary.
 */
export const AGE_BIN = findAge();

function findAge(): string | undefined {
	const candidates = [process.env.AGE_BIN, 'age', path.join(os.homedir(), 'go', 'bin', 'age')];
	for (const candidate of candidates) {
		if (candidate && spawnSync(candidate, ['--version']).status === 0) {
			return candidate;
		}
	}
	return undefined;
}

/** Runs the age CLI non-interactively (test-only: passphrase via env). */
export function ageCli(args: string[], input: Uint8Array | string, passphrase?: string): Buffer {
	if (!AGE_BIN) {
		throw new Error('age CLI not found');
	}
	const dir = path.dirname(AGE_BIN);
	const env: NodeJS.ProcessEnv = { ...process.env, PATH: dir === '.' ? process.env.PATH : `${dir}${path.delimiter}${process.env.PATH}` };
	if (passphrase !== undefined) {
		env.AGE_PASSPHRASE = passphrase;
		args = [...args, '-j', 'batchpass'];
	}
	const r = spawnSync(AGE_BIN, args, { input, env, maxBuffer: 256 * 1024 * 1024 });
	if (r.status !== 0) {
		throw new Error(`age ${args.join(' ')} failed: ${r.stderr.toString()}`);
	}
	return r.stdout;
}

/** All bytes of all files below `dir`, to scan for leaked plaintext. */
export function readAllFiles(dir: string): Buffer[] {
	return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(e => e.isFile())
		.map(e => fs.readFileSync(path.join(e.parentPath, e.name)));
}
