import { App, TFile } from 'obsidian';
import type { CitationIndex } from './citationIndex';
import type { OpenAlexClient } from './openalex';
import type { LiteratureGraphSettings } from './settings';

/**
 * The topics of a literature note, in its topics property (see the setting
 * "Topics property"): what the note says, if anything. The user may edit
 * them; the plugin then reads them instead of OpenAlex's (see `workTopics`
 * in the graph view).
 */
export function topicsInNote(app: App, file: TFile, property: string): string[] {
	const value: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.[property];
	const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
	return list.map((v) => String(v ?? '').trim()).filter(Boolean);
}

/**
 * Writes the topics OpenAlex gives each literature note (its DOI's work)
 * into the note's topics property, most relevant first. Only notes whose
 * property is missing or empty are written: topics the user has edited are
 * never replaced. Returns how many notes were written, already had topics,
 * or have no topics on OpenAlex (no DOI, or unknown).
 */
export async function writeTopicsToNotes(
	app: App,
	index: CitationIndex,
	openAlex: OpenAlexClient,
	settings: LiteratureGraphSettings,
	onStatus: (message: string) => void,
): Promise<{ written: number; kept: number; none: number }> {
	const property = settings.topicsProperty.trim() || 'topics';
	const files = app.vault.getMarkdownFiles().filter((f) => index.isLiterature(f));
	const dois = new Map(files.map((f) => [f, index.doiForFile(f)]));
	onStatus('looking up the works on OpenAlex…');
	await openAlex.worksByDois([...dois.values()].filter((d): d is string => d !== null));
	const ids = [...dois.values()].flatMap((d) => {
		const id = d ? openAlex.cachedIdForDoi(d) : null;
		return id ? [id] : [];
	});
	await openAlex.loadTopics(ids, (done, total) => onStatus(`loading topics: ${done} of ${total}…`));
	let written = 0;
	let kept = 0;
	let none = 0;
	for (const file of files) {
		if (topicsInNote(app, file, property).length > 0) {
			kept++;
			continue;
		}
		const doi = dois.get(file);
		const id = doi ? openAlex.cachedIdForDoi(doi) : null;
		const names = (id ? (openAlex.cachedWork(id)?.topics ?? []) : []).map(([topic]) => openAlex.topicInfo(topic)?.name ?? '').filter(Boolean);
		if (names.length === 0) {
			none++;
			continue;
		}
		await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			frontmatter[property] = names;
		});
		written++;
		if (written % 10 === 0) onStatus(`writing: ${written} notes…`);
	}
	return { written, kept, none };
}
