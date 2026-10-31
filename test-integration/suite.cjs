// Runs inside the VS Code extension host. No test framework on purpose:
// a handful of sequential steps that throw on failure.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vscode = require('vscode');

const { AGE_MD_ROOT, AGE_MD_WORKSPACE, AGE_MD_USER_DATA, AGE_MD_PASSWORD } = process.env;
const notesPath = path.join(AGE_MD_WORKSPACE, 'notes.md.age');
const TYPED = 'TYPED-PLAINTEXT-9e2b';
const EXTERNAL = 'EXTERNAL-CHANGE-51aa';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 15000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (await predicate()) {
			return;
		}
		await sleep(200);
	}
	throw new Error('Timed out waiting for condition');
}

/** Files below `dir` whose bytes contain `needle`. */
function filesContaining(dir, needle) {
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(e => e.isFile())
		.map(e => path.join(e.parentPath, e.name))
		.filter(f => {
			try {
				return fs.readFileSync(f).includes(Buffer.from(needle));
			} catch {
				return false;
			}
		});
}

async function ageLib() {
	return import(pathToFileURL(path.join(AGE_MD_ROOT, 'node_modules', 'age-encryption', 'dist', 'index.js')).href);
}

async function decryptFile(file) {
	const { Decrypter } = await ageLib();
	const d = new Decrypter();
	d.addPassphrase(AGE_MD_PASSWORD);
	return d.decrypt(fs.readFileSync(file), 'text');
}

async function encryptText(text) {
	const { Encrypter } = await ageLib();
	const e = new Encrypter();
	e.setPassphrase(AGE_MD_PASSWORD);
	return e.encrypt(text);
}

const steps = [];
const step = (name, fn) => steps.push({ name, fn });
let api;
let doc;

step('activates and exposes the test API only in test mode', async () => {
	const ext = vscode.extensions.getExtension('vithnilica.age-markdown');
	api = await ext.activate();
	assert.ok(api?.passwords, 'test API missing');
	// Pre-seed the password: input boxes cannot be answered from a test.
	api.passwords.remember(notesPath, AGE_MD_PASSWORD);
});

step('opens an encrypted file as an editable Markdown document', async () => {
	await vscode.commands.executeCommand('ageMarkdown.openEncryptedFile', vscode.Uri.file(notesPath));
	doc = vscode.window.activeTextEditor?.document;
	assert.equal(doc?.uri.scheme, 'age-md');
	assert.match(doc.getText(), /INITIAL-CONTENT-4d1c/);
	assert.equal(doc.languageId, 'markdown');
	assert.equal(doc.isDirty, false);
});

step('edits mark the document dirty', async () => {
	// Note: an extension development host keeps hot exit backups in memory only,
	// so the on-disk backup behaviour is verified by backup-probe.mjs instead.
	const editor = vscode.window.activeTextEditor;
	await editor.edit(b => b.insert(new vscode.Position(doc.lineCount, 0), `${TYPED}\n`));
	assert.equal(doc.isDirty, true);
	await sleep(3000);
});

step('Ctrl+S encrypts and writes only ciphertext', async () => {
	assert.equal(await doc.save(), true);
	assert.equal(doc.isDirty, false);
	assert.match(await decryptFile(notesPath), new RegExp(TYPED));
	assert.equal(fs.readFileSync(notesPath).includes(Buffer.from(TYPED)), false);
	assert.deepEqual(fs.readdirSync(AGE_MD_WORKSPACE), ['notes.md.age']);
});

step('after saving, no plaintext is found in the user data dir (e.g. no Local History entry)', async () => {
	await waitFor(() => filesContaining(AGE_MD_USER_DATA, TYPED).length === 0, 10000).catch(() => undefined);
	const leftovers = filesContaining(AGE_MD_USER_DATA, TYPED);
	console.log(`[finding] plaintext files in user data after save: ${JSON.stringify(leftovers)}`);
	assert.deepEqual(leftovers, []);
	assert.deepEqual(filesContaining(AGE_MD_WORKSPACE, TYPED), []);
});

step('reloads the document when the file changes on disk', async () => {
	fs.writeFileSync(notesPath, await encryptText(`# Notes\n\n${EXTERNAL}\n`));
	await waitFor(() => doc.getText().includes(EXTERNAL));
	assert.equal(doc.isDirty, false);
});

step('saves again after the external change without a conflict', async () => {
	const editor = vscode.window.activeTextEditor;
	await editor.edit(b => b.insert(new vscode.Position(0, 0), 'second save\n'));
	assert.equal(await doc.save(), true);
	const text = await decryptFile(notesPath);
	assert.match(text, /^second save\n/);
	assert.match(text, new RegExp(EXTERNAL));
});

step('Lock All forgets passwords and closes saved encrypted editors', async () => {
	await vscode.commands.executeCommand('ageMarkdown.lockAll');
	assert.equal(api.passwords.isEmpty, true);
	const open = vscode.window.tabGroups.all.flatMap(g => g.tabs)
		.filter(t => t.input instanceof vscode.TabInputText && t.input.uri.scheme === 'age-md');
	assert.deepEqual(open, []);
});

exports.run = async function run() {
	let failed = 0;
	for (const { name, fn } of steps) {
		try {
			await fn();
			console.log(`  ✓ ${name}`);
		} catch (err) {
			failed++;
			console.log(`  ✗ ${name}\n    ${err?.stack ?? err}`);
			break; // later steps depend on earlier ones
		}
	}
	if (failed) {
		throw new Error(`${failed} integration step(s) failed`);
	}
};
