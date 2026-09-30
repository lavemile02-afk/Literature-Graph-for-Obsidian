import { App, debounce } from 'obsidian';
import { writePluginFile } from './pluginFiles';

/** Which work a ghost note shows (see `workView.ts`), as the store needs it. */
export interface GhostWork {
	id?: string | null;
	doi?: string | null;
	entry?: { text: string } | null;
}

/**
 * The key of a work's ghost note: its OpenAlex id, else its DOI, else the
 * text of its reference-list entry.
 */
export function ghostKey(work: GhostWork): string | null {
	if (work.id) return `id:${work.id}`;
	if (work.doi) return `doi:${work.doi.toLowerCase()}`;
	if (work.entry?.text) return `entry:${work.entry.text}`;
	return null;
}

/**
 * What was written in the ghost notes of the works outside the vault (their
 * properties and text), kept in a file of the plugin folder rather than as
 * notes: a ghost note becomes a note only with its "Create note" button.
 * The text also feeds the work's vector of meaning.
 */
export class GhostNoteStore {
	private notes: Record<string, string> = {};
	private loaded: Promise<void> | null = null;
	private dirty = false;
	private readonly write = debounce(() => void this.flush(), 2000, true);
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly app: App,
		private readonly path: string,
	) {}

	/** Calls `listener` (a little after) whenever a ghost note changes; returns what stops it. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Reads the file, once. */
	load(): Promise<void> {
		this.loaded ??= (async () => {
			try {
				if (await this.app.vault.adapter.exists(this.path)) {
					this.notes = JSON.parse(await this.app.vault.adapter.read(this.path)) as Record<string, string>;
				}
			} catch (error) {
				console.error('Literature Graph: could not read the ghost notes', error);
			}
		})();
		return this.loaded;
	}

	/** The text written in a work's ghost note, if any (after `load`). */
	get(work: GhostWork): string | undefined {
		for (const key of [ghostKey(work), work.doi ? ghostKey({ doi: work.doi }) : null]) {
			if (key && key in this.notes) return this.notes[key];
		}
		return undefined;
	}

	/** Keeps the text of a work's ghost note (written a little later). */
	set(work: GhostWork, text: string): void {
		const key = ghostKey(work);
		if (!key) return;
		this.notes[key] = text;
		this.changed();
	}

	/** Forgets a work's ghost note: its note was created, or its changes discarded. */
	delete(work: GhostWork): void {
		let found = false;
		for (const key of [ghostKey(work), work.doi ? ghostKey({ doi: work.doi }) : null]) {
			if (key && key in this.notes) {
				delete this.notes[key];
				found = true;
			}
		}
		if (found) this.changed();
	}

	private changed(): void {
		this.dirty = true;
		this.write();
	}

	/** Writes what changed (also on unload). */
	async flush(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		// Not written: tried again at the next change.
		if (!(await writePluginFile(this.app, this.path, JSON.stringify(this.notes)))) this.dirty = true;
		for (const listener of this.listeners) listener();
	}
}
