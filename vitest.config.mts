import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		// age's scrypt takes ~1-2 s per encryption or decryption.
		testTimeout: 120_000,
	},
});
