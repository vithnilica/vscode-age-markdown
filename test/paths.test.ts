import { describe, expect, it } from 'vitest';
import { isAgeMarkdownPath, withAgeMarkdownExtension } from '../src/paths';

describe('paths', () => {
	it('adds the .md.age extension', () => {
		expect(withAgeMarkdownExtension('/n/notes')).toBe('/n/notes.md.age');
		expect(withAgeMarkdownExtension('/n/notes.md')).toBe('/n/notes.md.age');
		expect(withAgeMarkdownExtension('/n/notes.age')).toBe('/n/notes.md.age');
		expect(withAgeMarkdownExtension('/n/notes.md.age')).toBe('/n/notes.md.age');
		expect(withAgeMarkdownExtension('/n/Notes.MD.AGE')).toBe('/n/Notes.MD.AGE');
		expect(withAgeMarkdownExtension('/n/v1.2')).toBe('/n/v1.2.md.age');
	});

	it('recognizes encrypted Markdown files', () => {
		expect(isAgeMarkdownPath('a.md.age')).toBe(true);
		expect(isAgeMarkdownPath('a.MD.Age')).toBe(true);
		expect(isAgeMarkdownPath('a.age')).toBe(false);
		expect(isAgeMarkdownPath('a.md')).toBe(false);
	});
});
