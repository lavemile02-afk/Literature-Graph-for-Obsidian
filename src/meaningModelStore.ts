import { App } from 'obsidian';
import type { MeaningBasis, Vocabulary } from './meaning';
import { packVector, unpackVector } from './meaningMap';
import { writePluginFile } from './pluginFiles';

const VERSION = 1;

/**
 * What meaning was learned from and what was learned (see `meaningModel` in
 * `graphView.ts`): the fingerprint of each text of the corpus, the
 * vocabulary and its main directions, and the map of the corpus.
 */
export interface LearnedMeaning {
	/** The fingerprint of the whole corpus when it was learned. */
	key: string;
	/** Fingerprint of each text of the corpus (note path or OpenAlex id → fingerprint). */
	sources: Record<string, string>;
	vocabulary: Vocabulary;
	basis: MeaningBasis;
	corpus: { ids: string[]; vectors: Float32Array[]; places: [number, number][] };
}

interface StoredMeaning {
	version: number;
	key: string;
	sources: Record<string, string>;
	terms: string[];
	idf: number[];
	k: number;
	/** The directions, one row of `k` values per term, each row on signed bytes scaled by `scales` (base 64). */
	basis: string;
	scales: number[];
	corpus: { ids: string[]; vectors: string[]; places: [number, number][] };
}

/** Bytes as base 64, in pieces (a single call would overflow the stack on millions of bytes). */
function toBase64(bytes: Uint8Array): string {
	let text = '';
	for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(text);
}

function fromBase64(text: string): Uint8Array {
	const raw = atob(text);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

/**
 * The meaning learned last, kept in a file of the plugin folder
 * (`meaning-model.json`, about 3 MB for 30,000 terms): learning it again
 * takes from 30 s to a few minutes, so a few notes changed are placed with
 * the meaning already learned (see `effectiveModelKey`), and it is learned
 * again only when much changed, or on request.
 */
export class MeaningModelStore {
	private stored: StoredMeaning | null = null;
	private decoded: LearnedMeaning | null = null;
	private loaded: Promise<void> | null = null;

	constructor(
		private readonly app: App,
		private readonly path: string,
	) {}

	/** Reads the file, once. */
	load(): Promise<void> {
		this.loaded ??= (async () => {
			try {
				if (await this.app.vault.adapter.exists(this.path)) {
					const data = JSON.parse(await this.app.vault.adapter.read(this.path)) as StoredMeaning;
					if (data.version === VERSION) this.stored = data;
				}
			} catch (error) {
				console.error('Literature Graph: could not read the learned meaning', error);
			}
		})();
		return this.loaded;
	}

	/** The fingerprint of the corpus the kept meaning was learned from, if any. */
	get key(): string | null {
		return this.stored?.key ?? null;
	}

	/** The fingerprint of each text of the corpus the kept meaning was learned from. */
	get sources(): Record<string, string> | null {
		return this.stored?.sources ?? null;
	}

	/** The kept meaning, decoded once. */
	get(): LearnedMeaning | null {
		const s = this.stored;
		if (!s) return null;
		if (this.decoded?.key === s.key) return this.decoded;
		const bytes = fromBase64(s.basis);
		const basis = new Float64Array(bytes.length);
		for (let t = 0; t < s.terms.length; t++) {
			const scale = s.scales[t] ?? 0;
			for (let c = 0; c < s.k; c++) basis[t * s.k + c] = (((bytes[t * s.k + c] ?? 0) << 24) >> 24) * scale;
		}
		this.decoded = {
			key: s.key,
			sources: s.sources,
			vocabulary: { index: new Map(s.terms.map((term, i) => [term, i])), idf: Float64Array.from(s.idf) },
			basis: { basis, k: s.k },
			corpus: {
				ids: s.corpus.ids,
				vectors: s.corpus.vectors.map((v) => unpackVector(v) ?? new Float32Array(s.k)),
				places: s.corpus.places,
			},
		};
		return this.decoded;
	}

	/** Keeps a meaning just learned (written at once: it is learned rarely). */
	async save(meaning: LearnedMeaning): Promise<void> {
		const terms = new Array<string>(meaning.vocabulary.index.size);
		for (const [term, i] of meaning.vocabulary.index) terms[i] = term;
		const k = meaning.basis.k;
		const bytes = new Uint8Array(terms.length * k);
		const scales: number[] = [];
		for (let t = 0; t < terms.length; t++) {
			let most = 0;
			for (let c = 0; c < k; c++) most = Math.max(most, Math.abs(meaning.basis.basis[t * k + c] ?? 0));
			const scale = most / 127 || 1;
			scales.push(scale);
			for (let c = 0; c < k; c++) bytes[t * k + c] = Math.round((meaning.basis.basis[t * k + c] ?? 0) / scale) & 0xff;
		}
		this.stored = {
			version: VERSION,
			key: meaning.key,
			sources: meaning.sources,
			terms,
			idf: Array.from(meaning.vocabulary.idf, (x) => Math.round(x * 1e5) / 1e5),
			k,
			basis: toBase64(bytes),
			scales,
			corpus: { ids: meaning.corpus.ids, vectors: meaning.corpus.vectors.map(packVector), places: meaning.corpus.places },
		};
		this.decoded = meaning;
		await writePluginFile(this.app, this.path, JSON.stringify(this.stored));
	}

	/** Forgets the kept meaning: it is learned again at the next computation. */
	async clear(): Promise<void> {
		this.stored = null;
		this.decoded = null;
		if (await this.app.vault.adapter.exists(this.path)) await this.app.vault.adapter.remove(this.path);
	}
}

/**
 * Whether the corpus changed little enough since the meaning was learned to
 * keep using it: at most `share` of its texts are new, gone or changed.
 */
export function changedLittle(now: Record<string, string>, then: Record<string, string>, share: number): boolean {
	const all = new Set([...Object.keys(now), ...Object.keys(then)]);
	let changed = 0;
	for (const id of all) if (now[id] !== then[id]) changed++;
	return changed <= share * all.size;
}
