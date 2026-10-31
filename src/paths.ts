export const SCHEME = 'age-md';
export const EXTENSION = '.md.age';

export function isAgeMarkdownPath(filePath: string): boolean {
	return filePath.toLowerCase().endsWith(EXTENSION);
}

/** Appends `.md.age` unless present: `notes` → `notes.md.age`, `notes.md` → `notes.md.age`, `notes.age` → `notes.md.age`. */
export function withAgeMarkdownExtension(filePath: string): string {
	if (isAgeMarkdownPath(filePath)) {
		return filePath;
	}
	let base = filePath;
	if (base.toLowerCase().endsWith('.age')) {
		base = base.slice(0, -'.age'.length);
	}
	if (base.toLowerCase().endsWith('.md')) {
		return `${base}.age`;
	}
	return `${base}${EXTENSION}`;
}
