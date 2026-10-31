// Verifies empirically what VS Code writes to disk for an unsaved document
// backed by a custom FileSystemProvider (hot exit backups, local history).
// Launches a normal (non-development) VS Code with the test-only probe
// extension installed. On Linux run under xvfb-run.
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// When started from a VS Code terminal, inherited VSCODE_* variables would make
// the CLI forward commands (e.g. --install-extension) to that running VS Code.
for (const key of Object.keys(process.env)) {
	if (key.startsWith('VSCODE_') || key === 'ELECTRON_RUN_AS_NODE') {
		delete process.env[key];
	}
}

const here = path.dirname(fileURLToPath(import.meta.url));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'age-md-probe-'));
const userData = path.join(base, 'user-data');
const extensionsDir = path.join(base, 'extensions');
const workspace = path.join(base, 'workspace');
fs.mkdirSync(workspace);

const vsix = path.join(base, 'backup-probe.vsix');
run(process.execPath, [path.join(here, '..', 'node_modules', '@vscode', 'vsce', 'vsce'), 'package', '--allow-missing-repository', '--skip-license', '--out', vsix], { cwd: path.join(here, 'backup-probe') });

const codePath = await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION ?? 'stable');
const [cli] = resolveCliArgsFromVSCodeExecutablePath(codePath);
run(cli, [`--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`, '--install-extension', vsix]);

function launch(phase) {
	const out = path.join(base, `${phase}.json`);
	spawnSync(codePath, [workspace, `--user-data-dir=${userData}`, `--extensions-dir=${extensionsDir}`, '--disable-gpu', '--disable-workspace-trust'], {
		env: { ...process.env, AGE_MD_PROBE_OUT: out, AGE_MD_PROBE_USER_DATA: userData, AGE_MD_PROBE_PHASE: phase },
		timeout: 120_000,
		stdio: 'ignore',
	});
	return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function run(cmd, args, options = {}) {
	const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
	if (r.status !== 0) {
		throw new Error(`${cmd} ${args.join(' ')} failed`);
	}
}

function backupsContaining(needle) {
	const dir = path.join(userData, 'Backups');
	return fs.existsSync(dir)
		? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
			.filter(e => fs.readFileSync(path.join(e.parentPath, e.name)).includes(Buffer.from(needle)))
			.map(e => path.relative(dir, path.join(e.parentPath, e.name)))
		: [];
}

try {
	const edit = launch('edit');
	const afterQuit = backupsContaining('PROBE-UNSAVED-TEXT-8c2d');
	const restart = launch('restart');
	const findings = { edit, backupsAfterQuit: afterQuit, restart };
	console.log(JSON.stringify(findings, null, 2));
	// The README's security section relies on these observations. If VS Code
	// changes its behaviour, this fails and the documentation must be revisited.
	const expected = {
		'unsaved text is backed up to disk while dirty': edit.backupsWhileDirty?.length > 0,
		'the backup is deleted after saving': edit.backupsAfterSave?.length === 0,
		'no other copy (e.g. Local History) exists after saving': edit.userDataAfterSave?.length === 0,
		'quitting with unsaved changes keeps the plaintext backup': afterQuit.length > 0,
		'the unsaved text is restored on the next start': restart.restoredDocumentHasUnsavedText === true,
	};
	for (const [label, ok] of Object.entries(expected)) {
		console.log(`${ok ? '✓' : '✗'} ${label}`);
		if (!ok) {
			process.exitCode = 1;
		}
	}
	if (!process.env.AGE_MD_KEEP) {
		fs.rmSync(base, { recursive: true, force: true });
	}
} catch (err) {
	console.error(err);
	console.error('Probe data kept in', base);
	process.exitCode = 1;
}
