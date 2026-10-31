/**
 * In-memory password cache. Nothing here is ever persisted or logged.
 *
 * JavaScript strings cannot be wiped, so forgetting a password only drops the
 * reference; the garbage collector reclaims the memory at some later point.
 */
export class PasswordCache {
	private readonly perFile = new Map<string, string>();
	private shared: string | undefined;

	constructor(private readonly shareAcrossFiles: () => boolean) {}

	/** Password the file was opened or created with, needed to re-encrypt on save. */
	get(filePath: string): string | undefined {
		return this.perFile.get(filePath);
	}

	/** Passwords worth trying before prompting, most specific first. */
	candidates(filePath: string): string[] {
		const result: string[] = [];
		const own = this.perFile.get(filePath);
		if (own !== undefined) {
			result.push(own);
		}
		if (this.shareAcrossFiles() && this.shared !== undefined && this.shared !== own) {
			result.push(this.shared);
		}
		return result;
	}

	remember(filePath: string, password: string): void {
		this.perFile.set(filePath, password);
		if (this.shareAcrossFiles()) {
			this.shared = password;
		}
	}

	forget(filePath: string): void {
		this.perFile.delete(filePath);
	}

	clear(): void {
		this.perFile.clear();
		this.shared = undefined;
	}

	get isEmpty(): boolean {
		return this.perFile.size === 0 && this.shared === undefined;
	}
}
