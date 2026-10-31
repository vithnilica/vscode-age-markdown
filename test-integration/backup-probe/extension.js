// Test-only extension, installed like a regular extension (not as a
// development extension, for which VS Code keeps backups in memory only).
// It registers a minimal FileSystemProvider -- the same mechanism Age Markdown
// uses -- edits a document and records which files on disk contain the text.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const MARK_SAVED = 'PROBE-SAVED-TEXT-1f0e';
const MARK_DIRTY = 'PROBE-UNSAVED-TEXT-8c2d';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
		})
		.map(f => path.relative(dir, f));
}

class MemoryFs {
	constructor() {
		this.content = Buffer.from('# probe\n');
		this.mtime = Date.now();
		this.emitter = new vscode.EventEmitter();
		this.onDidChangeFile = this.emitter.event;
	}
	watch() { return new vscode.Disposable(() => undefined); }
	stat() { return { type: vscode.FileType.File, ctime: 0, mtime: this.mtime, size: this.content.length }; }
	readFile() { return this.content; }
	writeFile(_uri, content) { this.content = Buffer.from(content); this.mtime = Date.now(); }
	readDirectory() { return []; }
	createDirectory() {}
	delete() {}
	rename() {}
}

exports.activate = async function activate(context) {
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider('probe-md', new MemoryFs(), { isCaseSensitive: true }));
	const out = process.env.AGE_MD_PROBE_OUT;
	const userData = process.env.AGE_MD_PROBE_USER_DATA;
	const phase = process.env.AGE_MD_PROBE_PHASE;
	if (!out || !userData) {
		return;
	}
	const backups = path.join(userData, 'Backups');
	const result = { phase };
	try {
		if (phase === 'edit') {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse('probe-md:/note.md'));
			const editor = await vscode.window.showTextDocument(doc);
			await editor.edit(b => b.insert(new vscode.Position(0, 0), `${MARK_SAVED}\n`));
			await sleep(5000);
			result.backupsWhileDirty = filesContaining(backups, MARK_SAVED);
			await doc.save();
			await sleep(3000);
			result.backupsAfterSave = filesContaining(backups, MARK_SAVED);
			result.userDataAfterSave = filesContaining(userData, MARK_SAVED);
			await editor.edit(b => b.insert(new vscode.Position(0, 0), `${MARK_DIRTY}\n`));
			await sleep(5000);
			result.backupsDirtyAgain = filesContaining(backups, MARK_DIRTY);
		} else if (phase === 'restart') {
			await sleep(5000);
			const restored = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'probe-md');
			result.restoredDocumentHasUnsavedText = !!restored && restored.getText().includes(MARK_DIRTY);
			result.backupsAfterRestart = filesContaining(backups, MARK_DIRTY);
		}
	} catch (err) {
		result.error = String(err && err.stack || err);
	}
	fs.writeFileSync(out, JSON.stringify(result, null, 2));
	// Default files.hotExit ("onExit"): quitting keeps backups of dirty documents without asking.
	await vscode.commands.executeCommand('workbench.action.quit');
};
