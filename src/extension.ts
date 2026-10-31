import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgeCrypto } from './ageCrypto';
import { SCHEME, isAgeMarkdownPath, withAgeMarkdownExtension } from './paths';
import { PasswordCache } from './passwordCache';
import { AgeFileSystemProvider, toAgeUri, toFilePath } from './provider';
import { AgeFileStore, StoreUi } from './store';

/** Only returned when running extension tests; there is no public API. */
export interface TestApi {
	passwords: PasswordCache;
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
	const crypto = new AgeCrypto(path.join(context.extensionPath, 'dist', 'cryptoWorker.js'));
	const passwords = new PasswordCache(
		() => vscode.workspace.getConfiguration('ageMarkdown').get<boolean>('cachePassword', true),
	);
	const store = new AgeFileStore(crypto, passwords, ui);

	context.subscriptions.push(
		{ dispose: () => crypto.dispose() },
		{ dispose: () => passwords.clear() },
		vscode.workspace.registerFileSystemProvider(SCHEME, new AgeFileSystemProvider(store), {
			isCaseSensitive: process.platform === 'linux',
		}),
		vscode.workspace.onDidOpenTextDocument(ensureMarkdown),
		vscode.workspace.onDidCloseTextDocument(doc => {
			if (doc.uri.scheme !== SCHEME) {
				return;
			}
			// Changing the language mode closes and immediately reopens the
			// document, so check again a moment later before forgetting.
			const key = doc.uri.toString();
			setTimeout(() => {
				if (!vscode.workspace.textDocuments.some(d => d.uri.toString() === key)) {
					const file = toFilePath(doc.uri);
					store.forget(file);
					passwords.forget(file);
				}
			}, 1000);
		}),
		vscode.commands.registerCommand('ageMarkdown.openEncryptedFile', openEncryptedFile),
		vscode.commands.registerCommand('ageMarkdown.newEncryptedFile', () => newEncryptedFile(store)),
		vscode.commands.registerCommand('ageMarkdown.lockAll', () => lockAll(passwords)),
		vscode.commands.registerCommand('ageMarkdown.forgetPasswords', () => {
			passwords.clear();
			void vscode.window.showInformationMessage(
				'Age Markdown: Passwords forgotten. Open editors still contain the decrypted text; close them (or use "Lock All") to lock the files.',
			);
		}),
	);
	vscode.workspace.textDocuments.forEach(ensureMarkdown);

	return context.extensionMode === vscode.ExtensionMode.Test ? { passwords } : undefined;
}

export function deactivate(): void {}

const ui: StoreUi = {
	async promptPassword(filePath, retry) {
		return vscode.window.showInputBox({
			title: `Age Markdown: ${path.basename(filePath)}`,
			prompt: retry ? 'Wrong password. Try again.' : `Password for ${filePath}`,
			password: true,
			ignoreFocusOut: true,
		});
	},
	async promptNewPassword(filePath) {
		const title = `Age Markdown: ${path.basename(filePath)}`;
		const password = await vscode.window.showInputBox({
			title,
			prompt: `Choose a password for the new encrypted file ${filePath}`,
			password: true,
			ignoreFocusOut: true,
			validateInput: v => (v.length === 0 ? 'The password must not be empty.' : undefined),
		});
		if (password === undefined) {
			return undefined;
		}
		const confirmation = await vscode.window.showInputBox({ title, prompt: 'Repeat the password', password: true, ignoreFocusOut: true });
		if (confirmation === undefined) {
			return undefined;
		}
		if (confirmation !== password) {
			void vscode.window.showErrorMessage('Age Markdown: The passwords do not match. No file was created.');
			return undefined;
		}
		return password;
	},
	async confirmOverwrite(filePath) {
		const overwrite = 'Overwrite';
		const answer = await vscode.window.showWarningMessage(
			`"${path.basename(filePath)}" was changed on disk after it was opened. Overwrite those changes?`,
			{ modal: true, detail: 'Cancel keeps your unsaved changes in the editor and leaves the file on disk untouched.' },
			overwrite,
		);
		return answer === overwrite;
	},
};

function ensureMarkdown(doc: vscode.TextDocument): void {
	if (doc.uri.scheme === SCHEME && doc.languageId !== 'markdown') {
		void vscode.languages.setTextDocumentLanguage(doc, 'markdown');
	}
}

async function openEncryptedFile(uri?: vscode.Uri, selected?: vscode.Uri[]): Promise<void> {
	let targets = selected?.length ? selected : uri ? [uri] : [];
	let tabToReplace: vscode.Tab | undefined;

	if (targets.length === 0) {
		// A *.md.age opened from the Explorer shows up as a raw (binary) file.
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (tab?.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file' && isAgeMarkdownPath(tab.input.uri.fsPath)) {
			targets = [tab.input.uri];
			tabToReplace = tab;
		}
	} else if (uri) {
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (tab?.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()) {
			tabToReplace = tab;
		}
	}

	if (targets.length === 0) {
		targets = (await vscode.window.showOpenDialog({
			canSelectMany: true,
			filters: { 'Encrypted Markdown': ['age'] },
			openLabel: 'Open Encrypted',
			title: 'Open Encrypted Markdown File',
		})) ?? [];
	}

	for (const target of targets) {
		if (target.scheme !== 'file') {
			void vscode.window.showErrorMessage(`Age Markdown: Only local files are supported (${target.toString()}).`);
			continue;
		}
		try {
			const doc = await vscode.workspace.openTextDocument(toAgeUri(target));
			await vscode.window.showTextDocument(doc, { preview: false });
			if (tabToReplace) {
				await vscode.window.tabGroups.close(tabToReplace);
				tabToReplace = undefined;
			}
		} catch (err) {
			void vscode.window.showErrorMessage(`Age Markdown: Cannot open ${path.basename(target.fsPath)}: ${errorMessage(err)}`);
		}
	}
}

async function newEncryptedFile(store: AgeFileStore): Promise<void> {
	const activeFile = vscode.window.activeTextEditor?.document.uri;
	const folder = (activeFile && vscode.workspace.getWorkspaceFolder(activeFile)) ?? vscode.workspace.workspaceFolders?.[0];
	const picked = await vscode.window.showSaveDialog({
		defaultUri: folder ? vscode.Uri.joinPath(folder.uri, 'notes.md.age') : undefined,
		filters: { 'Encrypted Markdown': ['age'] },
		saveLabel: 'Create',
		title: 'New Encrypted Markdown File',
	});
	if (!picked) {
		return;
	}
	if (picked.scheme !== 'file') {
		void vscode.window.showErrorMessage('Age Markdown: Only local files are supported.');
		return;
	}

	const target = withAgeMarkdownExtension(picked.fsPath);
	if (await fs.stat(target).then(() => true, () => false)) {
		// Never replace an existing file (and its notes) with an empty one.
		void vscode.window.showErrorMessage(`Age Markdown: ${path.basename(target)} already exists. Use "Open Encrypted File" to edit it.`);
		return;
	}

	const password = await ui.promptNewPassword(target);
	if (password === undefined) {
		return;
	}

	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Encrypting ${path.basename(target)}…` },
			() => store.create(target, new Uint8Array(), password),
		);
		const doc = await vscode.workspace.openTextDocument(toAgeUri(vscode.Uri.file(target)));
		await vscode.window.showTextDocument(doc, { preview: false });
	} catch (err) {
		void vscode.window.showErrorMessage(`Age Markdown: Cannot create ${path.basename(target)}: ${errorMessage(err)}`);
	}
}

async function lockAll(passwords: PasswordCache): Promise<void> {
	passwords.clear();
	const tabs = vscode.window.tabGroups.all
		.flatMap(group => group.tabs)
		.filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === SCHEME);
	// Never discard unsaved work: only close editors without pending changes.
	const dirty = tabs.filter(tab => tab.isDirty);
	await vscode.window.tabGroups.close(tabs.filter(tab => !tab.isDirty));

	if (dirty.length > 0) {
		void vscode.window.showWarningMessage(
			`Age Markdown: Passwords forgotten, but ${dirty.length} encrypted file(s) have unsaved changes and were left open. Save or revert them, then close them to lock.`,
		);
	} else {
		void vscode.window.showInformationMessage('Age Markdown: Passwords forgotten and encrypted editors closed.');
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
