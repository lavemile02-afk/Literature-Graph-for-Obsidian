import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { App } from 'obsidian';
import { changedLittle, MeaningModelStore } from '../src/meaningModelStore';

/** An app whose vault keeps files in memory. */
function memoryApp(): App {
	const files = new Map<string, string>();
	const adapter = {
		exists: async (path: string) => files.has(path),
		read: async (path: string) => files.get(path) ?? '',
		write: async (path: string, data: string) => void files.set(path, data),
		remove: async (path: string) => void files.delete(path),
	};
	return { vault: { adapter } } as unknown as App;
}

test('keeps a learned meaning, and reads it back in another session', async () => {
	const app = memoryApp();
	const k = 4;
	const basis = Float64Array.from({ length: 3 * k }, (_, i) => Math.sin(i + 1) * 0.3);
	const store = new MeaningModelStore(app, 'meaning-model.json');
	await store.save({
		key: 'abc',
		sources: { 'Notes/A.md': 'f1', W1: 'f2' },
		vocabulary: { index: new Map([['peat', 0], ['water', 1], ['table', 2]]), idf: Float64Array.from([1.5, 0.7, 2.25]) },
		basis: { basis, k },
		corpus: { ids: ['Notes/A.md'], vectors: [Float32Array.from([0.5, 0.5, 0.5, 0.5])], places: [[0.25, -1]] },
	});
	// Another session: a new store reads the file.
	const again = new MeaningModelStore(app, 'meaning-model.json');
	await again.load();
	const read = again.get();
	assert.equal(read?.key, 'abc');
	assert.deepEqual(read?.sources, { 'Notes/A.md': 'f1', W1: 'f2' });
	assert.equal(read?.vocabulary.index.get('table'), 2);
	assert.deepEqual(Array.from(read?.vocabulary.idf ?? []), [1.5, 0.7, 2.25]);
	// The directions, kept on one byte each: within 1 % of their largest value.
	read?.basis.basis.forEach((x, i) => assert.ok(Math.abs(x - (basis[i] ?? 0)) < 0.01 * 0.3, `${x} ${basis[i]}`));
	assert.deepEqual(read?.corpus.places, [[0.25, -1]]);
	await again.clear();
	const cleared = new MeaningModelStore(app, 'meaning-model.json');
	await cleared.load();
	assert.equal(cleared.get(), null);
});

test('keeps the learned meaning while a tenth of its texts at most changed', () => {
	const then = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`n${i}`, 'x']));
	assert.ok(changedLittle({ ...then, n0: 'y', n1: 'y' }, then, 0.1));
	assert.ok(!changedLittle({ ...then, n0: 'y', n1: 'y', n2: 'y' }, then, 0.1));
	// A new note and a removed one count too.
	assert.ok(!changedLittle({ ...then, n0: 'y', n20: 'x', n21: 'x' }, then, 0.1));
});
