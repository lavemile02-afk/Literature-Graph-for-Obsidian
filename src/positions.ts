import { App, debounce } from 'obsidian';

/** Positions of the works in the graph, by layout style, then by work id. */
type SavedPositions = Record<string, Record<string, [number, number]>>;

/**
 * Where the works of the graph were when its layout last came to rest, one
 * set per layout style, kept in a file of the plugin folder: at the next
 * opening each work starts from its place, so the graph keeps its shape.
 */
export class PositionStore {
	private positions: SavedPositions = {};
	private loaded: Promise<void> | null = null;
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
					this.positions = JSON.parse(await this.app.vault.adapter.read(this.path)) as SavedPositions;
				}
			} catch (error) {
				console.error('Literature Graph: could not read the saved positions', error);
			}
		})();
		return this.loaded;
	}

	/** The saved positions of a layout style (empty if none). */
	get(style: string): Record<string, [number, number]> {
		return this.positions[style] ?? {};
	}

	/** Saves the positions of a layout style (written a little later). */
	set(style: string, positions: Record<string, [number, number]>): void {
		this.positions[style] = positions;
		this.dirty = true;
		this.write();
	}

	/** Writes what changed (also on unload); never writes over the file what was not read from it. */
	async flush(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		await this.app.vault.adapter.write(this.path, JSON.stringify(this.positions));
	}

	private dirty = false;
}
