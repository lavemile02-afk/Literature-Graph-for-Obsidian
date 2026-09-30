import { App, TFile } from 'obsidian';
import type { CitationIndex } from './citationIndex';
import type { OpenAlexClient } from './openalex';
import type { LiteratureGraphSettings } from './settings';

/** The property of the keywords, from the settings. */
export const keywordsProperty = (settings: LiteratureGraphSettings): string => settings.keywordsProperty.trim() || 'keywords';

/**
 * The keywords of a literature note, in its keywords property (see the
 * setting "Keywords property"): what the note says, if anything. The user
 * may edit them; they are part of the text of the note's vector of meaning.
 */
export function keywordsInNote(app: App, file: TFile, property: string): string[] {
	const value: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.[property];
	const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
	return list.map((v) => String(v ?? '').trim()).filter(Boolean);
}

/**
 * Writes the keywords OpenAlex gives each literature note (its DOI's work)
 * into the note's keywords property, most relevant first. Only notes whose
 * property is missing or empty are written: keywords the user has edited
 * are never replaced. Returns how many notes were written, already had
 * keywords, or have none on OpenAlex (no DOI, or unknown).
 */
export async function writeKeywordsToNotes(
	app: App,
	index: CitationIndex,
	openAlex: OpenAlexClient,
	settings: LiteratureGraphSettings,
	onStatus: (message: string) => void,
): Promise<{ written: number; kept: number; none: number }> {
	const property = keywordsProperty(settings);
	const files = app.vault.getMarkdownFiles().filter((f) => index.isLiterature(f));
	const dois = new Map(files.map((f) => [f, index.doiForFile(f)]));
	onStatus('looking up the works on OpenAlex…');
	await openAlex.worksByDois([...dois.values()].filter((d): d is string => d !== null));
	const ids = [...dois.values()].flatMap((d) => {
		const id = d ? openAlex.cachedIdForDoi(d) : null;
		return id ? [id] : [];
	});
	await openAlex.loadExtras(ids, (done, total) => onStatus(`loading keywords: ${done} of ${total}…`));
	let written = 0;
	let kept = 0;
	let none = 0;
	for (const file of files) {
		if (keywordsInNote(app, file, property).length > 0) {
			kept++;
			continue;
		}
		const doi = dois.get(file);
		const id = doi ? openAlex.cachedIdForDoi(doi) : null;
		const names = (id ? (openAlex.cachedWork(id)?.keywords ?? []) : []).map(([name]) => name);
		if (names.length === 0) {
			none++;
			continue;
		}
		let wrote = false;
		await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			// Checked again on the file itself: Obsidian's cache may lag behind an edit.
			const value = frontmatter[property];
			const empty = value === undefined || value === null || (Array.isArray(value) ? value.length === 0 : typeof value === 'string' && value.trim() === '');
			if (!empty) return;
			frontmatter[property] = names;
			wrote = true;
		});
		if (wrote) written++;
		else {
			kept++;
			continue;
		}
		if (written % 10 === 0) onStatus(`writing: ${written} notes…`);
	}
	return { written, kept, none };
}
