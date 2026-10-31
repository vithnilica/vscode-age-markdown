import { Worker } from 'node:worker_threads';

// age's scrypt is deliberately slow (~1-2 s) and the JavaScript implementation
// is synchronous, so all crypto runs in a worker thread to keep the extension
// host responsive. The passphrase is handed over via postMessage, i.e. it stays
// in memory and never appears in process arguments, environment or files.

export type AgeErrorCode =
	| 'wrong-password'
	| 'not-passphrase-encrypted'
	| 'work-factor-too-high'
	| 'corrupted'
	| 'too-large'
	| 'internal';

export class AgeError extends Error {
	constructor(readonly code: AgeErrorCode, message: string) {
		super(message);
		this.name = 'AgeError';
	}
}

export type WorkerRequest =
	| { id: number; op: 'encrypt'; data: Uint8Array; passphrase: string; armor: boolean }
	| { id: number; op: 'decrypt'; data: Uint8Array; passphrase: string };

export type WorkerResponse =
	| { id: number; ok: true; data: Uint8Array; armored: boolean }
	| { id: number; ok: false; code: AgeErrorCode; message: string };

export interface Decrypted {
	plaintext: Uint8Array;
	/** True if the file used the ASCII-armored (PEM) encoding. */
	armored: boolean;
}

export class AgeCrypto {
	private worker: Worker | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve(r: WorkerResponse): void; reject(e: Error): void }>();

	constructor(private readonly workerPath: string) {}

	async encrypt(plaintext: Uint8Array, passphrase: string, armor = false): Promise<Uint8Array> {
		const r = await this.call({ id: this.nextId++, op: 'encrypt', data: plaintext, passphrase, armor });
		return r.data;
	}

	async decrypt(ciphertext: Uint8Array, passphrase: string): Promise<Decrypted> {
		const r = await this.call({ id: this.nextId++, op: 'decrypt', data: ciphertext, passphrase });
		return { plaintext: r.data, armored: r.armored };
	}

	dispose(): void {
		const worker = this.worker;
		this.worker = undefined;
		void worker?.terminate();
		this.failAll(new AgeError('internal', 'Crypto worker was stopped.'));
	}

	private call(request: WorkerRequest): Promise<WorkerResponse & { ok: true }> {
		const worker = this.getWorker();
		return new Promise((resolve, reject) => {
			this.pending.set(request.id, {
				resolve: r => (r.ok ? resolve(r) : reject(new AgeError(r.code, r.message))),
				reject,
			});
			worker.postMessage(request);
		});
	}

	private getWorker(): Worker {
		if (!this.worker) {
			const worker = new Worker(this.workerPath);
			worker.on('message', (r: WorkerResponse) => {
				const p = this.pending.get(r.id);
				this.pending.delete(r.id);
				p?.resolve(r);
			});
			worker.on('error', err => {
				this.worker = undefined;
				this.failAll(new AgeError('internal', `Crypto worker failed: ${err.message}`));
			});
			worker.on('exit', () => {
				if (this.worker === worker) {
					this.worker = undefined;
					this.failAll(new AgeError('internal', 'Crypto worker exited unexpectedly.'));
				}
			});
			// Do not keep the process alive just because of an idle worker.
			worker.unref();
			this.worker = worker;
		}
		return this.worker;
	}

	private failAll(err: Error): void {
		for (const p of this.pending.values()) {
			p.reject(err);
		}
		this.pending.clear();
	}
}
