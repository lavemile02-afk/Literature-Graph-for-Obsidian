import type { App } from 'obsidian';

/** Attempts to write a file of the plugin folder, and the wait before each new attempt (ms). */
const RETRY_DELAYS = [500, 2000];

/**
 * Writes a file of the plugin folder (cache, positions, ghost notes). On
 * Windows, a write fails when another program holds the file for a moment
 * (a backup of the vault, an antivirus, a synchronization): it is tried
 * again a little later. Returns whether the file was written; a failure is
 * logged, never thrown, since these files are only kept for later.
 */
export async function writePluginFile(app: App, path: string, data: string): Promise<boolean> {
	for (let attempt = 0; ; attempt++) {
		try {
			await app.vault.adapter.write(path, data);
			return true;
		} catch (error) {
			const delay = RETRY_DELAYS[attempt];
			if (delay === undefined) {
				console.error(`Literature Graph: could not write ${path}`, error);
				return false;
			}
			await new Promise((resolve) => window.setTimeout(resolve, delay));
		}
	}
}
