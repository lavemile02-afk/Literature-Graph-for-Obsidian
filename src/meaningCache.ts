import { App, debounce } from 'obsidian';
import { writePluginFile } from './pluginFiles';
import { packVector, unpackVector } from './meaningMap';

/**
 * 5: notes in another language than most take in the meaning of the works
 * they cite. 4: note fingerprints that no longer depend on when the citation index
 * read the note (3 kept unstable ones). 3: the UMAP map learned on the
 * works of reliable meaning only (2: on all
 * the corpus; 1: places in the plane of the two main directions).
 */
const CACHE_VERSION = 5;

/** A work's place in the plane of meaning, and the fingerprint of the text it comes from. */
interface PlaceEntry {
	text: string;
	place: [number, number] | null;
	/** Its vector of meaning (see `packVector`), for the semantic tree and the names of the regions. */
	vector?: string;
}

/** The fingerprint of a note's words, while the file and the keywords property are the same. */
interface NoteEntry {
	mtime: number;
	size: number;
	/** The keywords property read with the note. */
	property: string;
	text: string;
}

interface CacheFile {
	version: number;
	/** What the meaning was learned from (see `graphView.ts`): another key, other places. */
	model: string;
	places: Record<string, PlaceEntry>;
	/** Fingerprints of the notes of the vault, so that opening the graph needs not read them all again. */
	notes?: Record<string, NoteEntry>;
	/** Where the works of the corpus were on the last map learned: a new map is turned to match it (see `alignTo`). */
	corpus?: Record<string, [number, number]>;
	/** The meaning that map was learned with: the same meaning needs no new map. */
	corpusModel?: string;
}

/**
 * The places of the works in the plane of meaning (which give their
 * colors), kept in a file of the plugin folder: opening the graph again
 * needs no computation. A place is used only while what it was computed
 * from is the same: the same meaning (learned from the notes of the vault)
 * and the same text of the work (compared by fingerprint).
 */
export class MeaningCache {
	private cache: CacheFile = { version: CACHE_VERSION, model: '', places: {} };
	private loaded: Promise<void> | null = null;
	/** Whether the file was read (the cache can then be used without waiting). */
	isLoaded = false;
	private dirty = false;
	private readonly write = debounce(() => void this.flush(), 2000, true);

	constructor(
		private readonly app: App,
		private readonly path: string,
	) {}

	/** Reads the file, once. */
	load(): Promise<void> {
		this.loaded ??= (async () => {
			try {
				if (await this.app.vault.adapter.exists(this.path)) {
					const data = JSON.parse(await this.app.vault.adapter.read(this.path)) as CacheFile;
					if (data.version === CACHE_VERSION) this.cache = data;
				}
			} catch (error) {
				console.error('Literature Graph: could not read the meaning cache', error);
			}
			this.isLoaded = true;
		})();
		return this.loaded;
	}

	/** Whether the places kept were computed with this meaning. */
	hasModel(model: string): boolean {
		return this.cache.model === model;
	}

	/** Forgets every place and the map (the meaning is computed again from scratch); the fingerprints of the notes stay. */
	reset(): void {
		this.cache = { version: CACHE_VERSION, model: '', places: {}, notes: this.cache.notes };
		this.changed();
	}

	/** Starts over when the meaning was learned from something else (the notes of the vault changed). */
	useModel(model: string): void {
		if (this.cache.model === model) return;
		// (The fingerprints of the notes do not depend on the meaning: they stay.)
		this.cache = { version: CACHE_VERSION, model, places: {}, notes: this.cache.notes, corpus: this.cache.corpus, corpusModel: this.cache.corpusModel };
		this.changed();
	}

	/** The fingerprint of a note's words, if the note (its date and size) and the keywords property are the same as when it was kept. */
	noteText(path: string, mtime: number, size: number, property: string): string | undefined {
		const entry = this.cache.notes?.[path];
		return entry && entry.mtime === mtime && entry.size === size && entry.property === property ? entry.text : undefined;
	}

	/** Keeps the fingerprint of a note's words (written a little later). */
	setNote(path: string, mtime: number, size: number, property: string, text: string): void {
		const notes = (this.cache.notes ??= {});
		const entry = notes[path];
		if (entry && entry.mtime === mtime && entry.size === size && entry.property === property && entry.text === text) return;
		notes[path] = { mtime, size, property, text };
		this.changed();
	}

	/** A work's place, if it was computed from this same text; undefined if not known. */
	place(id: string, text: string): [number, number] | null | undefined {
		const entry = this.cache.places[id];
		return entry && entry.text === text ? entry.place : undefined;
	}

	/** A work's vector of meaning, if it was kept with its place for this same text. */
	vector(id: string, text: string): Float32Array | null | undefined {
		const entry = this.cache.places[id];
		if (!entry || entry.text !== text) return undefined;
		return entry.vector ? unpackVector(entry.vector) : null;
	}

	/** Keeps a work's place and vector (written a little later). */
	setPlace(id: string, text: string, place: [number, number] | null, vector: Float32Array | null = null): void {
		this.cache.places[id] = vector ? { text, place, vector: packVector(vector) } : { text, place };
		this.changed();
	}

	/** The angles of the works of the corpus on the map kept (for even hues, see `evenHues`). */
	corpusAngles(): number[] {
		return Object.values(this.cache.corpus ?? {}).map(([x, y]) => Math.atan2(y, x));
	}

	/** The meaning the map kept was learned with. */
	get corpusKey(): string {
		return this.cache.corpusModel ?? '';
	}

	/** Where a work of the corpus was on the last map learned. */
	corpusPlace(id: string): [number, number] | null {
		return this.cache.corpus?.[id] ?? null;
	}

	/** Whether the map kept was learned with this meaning (then it needs not be learned again). */
	hasCorpusFor(model: string): boolean {
		return this.cache.corpusModel === model && this.cache.corpus !== undefined;
	}

	/** Keeps where the works of the corpus are on the map just learned with this meaning. */
	setCorpus(places: Record<string, [number, number]>, model: string): void {
		this.cache.corpus = places;
		this.cache.corpusModel = model;
		this.changed();
	}

	private changed(): void {
		this.dirty = true;
		this.write();
	}

	/** Writes what changed (also on unload). */
	async flush(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		if (!(await writePluginFile(this.app, this.path, JSON.stringify(this.cache)))) this.dirty = true;
	}
}
