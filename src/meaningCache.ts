import { App, debounce } from 'obsidian';
import { writePluginFile } from './pluginFiles';

const CACHE_VERSION = 1;

/** A work's place in the plane of meaning, and the fingerprint of the text it comes from. */
interface PlaceEntry {
	text: string;
	place: [number, number] | null;
}

interface CacheFile {
	version: number;
	/** What the meaning was learned from (see `graphView.ts`): another key, other places. */
	model: string;
	places: Record<string, PlaceEntry>;
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
		})();
		return this.loaded;
	}

	/** Starts over when the meaning was learned from something else (the notes of the vault changed). */
	useModel(model: string): void {
		if (this.cache.model === model) return;
		this.cache = { version: CACHE_VERSION, model, places: {} };
		this.changed();
	}

	/** A work's place, if it was computed from this same text; undefined if not known. */
	place(id: string, text: string): [number, number] | null | undefined {
		const entry = this.cache.places[id];
		return entry && entry.text === text ? entry.place : undefined;
	}

	/** Keeps a work's place (written a little later). */
	setPlace(id: string, text: string, place: [number, number] | null): void {
		this.cache.places[id] = { text, place };
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
