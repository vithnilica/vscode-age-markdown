import { parentPort } from 'node:worker_threads';
import { Decrypter, Encrypter, armor } from 'age-encryption';
import type { AgeErrorCode, WorkerRequest, WorkerResponse } from './ageCrypto';

const ARMOR_BEGIN = '-----BEGIN AGE ENCRYPTED FILE-----';

const port = parentPort;
if (!port) {
	throw new Error('cryptoWorker must run as a worker thread');
}

port.on('message', (req: WorkerRequest) => {
	handle(req).then(
		res => port.postMessage(res),
		// Never echo request data back: only the error code and a generic message.
		err => port.postMessage(toErrorResponse(req.id, req, err)),
	);
});

async function handle(req: WorkerRequest): Promise<WorkerResponse> {
	if (req.op === 'encrypt') {
		const e = new Encrypter();
		e.setPassphrase(req.passphrase);
		const ciphertext = await e.encrypt(req.data);
		const data = req.armor ? new TextEncoder().encode(armor.encode(ciphertext)) : ciphertext;
		return { id: req.id, ok: true, data, armored: req.armor };
	}

	const { binary, armored } = unarmor(req.data);
	const d = new Decrypter();
	d.addPassphrase(req.passphrase);
	const data = await d.decrypt(binary, 'uint8array');
	return { id: req.id, ok: true, data, armored };
}

function unarmor(data: Uint8Array): { binary: Uint8Array; armored: boolean } {
	const head = new TextDecoder().decode(data.subarray(0, 64)).trimStart();
	if (!head.startsWith(ARMOR_BEGIN)) {
		return { binary: data, armored: false };
	}
	return { binary: armor.decode(new TextDecoder().decode(data)), armored: true };
}

function toErrorResponse(id: number, req: WorkerRequest, err: unknown): WorkerResponse {
	const message = err instanceof Error ? err.message : String(err);
	let code: AgeErrorCode = 'corrupted';
	let text = `The file is not a valid age file or is damaged (${message}).`;
	if (req.op === 'encrypt') {
		code = 'internal';
		text = `Encryption failed (${message}).`;
	} else if (message.includes('no identity matched')) {
		if (hasScryptStanza(req.data)) {
			code = 'wrong-password';
			text = 'Wrong password.';
		} else {
			code = 'not-passphrase-encrypted';
			text = 'The file is encrypted to age keys, not with a password. Only password-protected files are supported.';
		}
	} else if (message.includes('work factor is too high')) {
		code = 'work-factor-too-high';
		text = 'The file uses an scrypt work factor higher than supported (max 20).';
	}
	return { id, ok: false, code, message: text };
}

function hasScryptStanza(data: Uint8Array): boolean {
	try {
		const { binary } = unarmor(data);
		// The header is plain text; recipient stanzas are lines starting with "-> ".
		return new TextDecoder().decode(binary.subarray(0, 4096)).includes('\n-> scrypt ');
	} catch {
		return false;
	}
}
