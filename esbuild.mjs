import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const options = {
	entryPoints: { extension: 'src/extension.ts', cryptoWorker: 'src/cryptoWorker.ts' },
	outdir: 'dist',
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node18',
	external: ['vscode'],
	sourcemap: !production,
	minify: production,
	logLevel: 'info',
};

if (watch) {
	await (await esbuild.context(options)).watch();
} else {
	await esbuild.build(options);
}
