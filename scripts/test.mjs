// Runs the tests: bundles each test/*.test.ts with esbuild (the "obsidian"
// module is replaced by a small stub, since Obsidian is not available outside
// the app), then runs them with Node's built-in test runner.
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const outdir = '.test-build';
rmSync(outdir, { recursive: true, force: true });
const entryPoints = readdirSync('test')
	.filter((f) => f.endsWith('.test.ts'))
	.map((f) => join('test', f));

try {
	await esbuild.build({
		entryPoints,
		outdir,
		bundle: true,
		platform: 'node',
		format: 'esm',
		outExtension: { '.js': '.mjs' },
		alias: { obsidian: './test/obsidian-stub.ts' },
		logLevel: 'warning',
	});
} catch {
	rmSync(outdir, { recursive: true, force: true });
	process.exit(1);
}

const files = readdirSync(outdir).map((f) => join(outdir, f));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
rmSync(outdir, { recursive: true, force: true });
process.exit(result.status ?? 1);
