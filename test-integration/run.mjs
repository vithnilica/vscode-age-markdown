// Runs test-integration/suite.cjs inside a real VS Code (downloaded by
// @vscode/test-electron) with a throwaway user data directory, so the suite can
// inspect what VS Code itself writes to disk. On Linux run under xvfb-run.
import { runTests } from '@vscode/test-electron';
import { Encrypter } from 'age-encryption';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Variables inherited from a VS Code terminal would make Electron run as plain
// Node or talk to that running VS Code instead of the test instance.
for (const key of Object.keys(process.env)) {
	if (key.startsWith('VSCODE_') || key === 'ELECTRON_RUN_AS_NODE') {
		delete process.env[key];
	}
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'age-md-it-'));
const workspace = path.join(base, 'workspace');
const userData = path.join(base, 'user-data');
fs.mkdirSync(workspace);

const password = 'integration-test-password';
const e = new Encrypter();
e.setPassphrase(password);
fs.writeFileSync(path.join(workspace, 'notes.md.age'), await e.encrypt('# Notes\n\nINITIAL-CONTENT-4d1c\n'));

try {
	await runTests({
		version: process.env.VSCODE_TEST_VERSION ?? 'stable',
		extensionDevelopmentPath: root,
		extensionTestsPath: path.join(root, 'test-integration', 'suite.cjs'),
		launchArgs: [workspace, '--disable-extensions', `--user-data-dir=${userData}`, '--disable-gpu'],
		extensionTestsEnv: {
			AGE_MD_ROOT: root,
			AGE_MD_WORKSPACE: workspace,
			AGE_MD_USER_DATA: userData,
			AGE_MD_PASSWORD: password,
		},
	});
} catch (err) {
	console.error('Integration tests failed:', err);
	process.exitCode = 1;
} finally {
	if (!process.env.AGE_MD_KEEP) {
		fs.rmSync(base, { recursive: true, force: true });
	} else {
		console.log('Kept test data in', base);
	}
}
