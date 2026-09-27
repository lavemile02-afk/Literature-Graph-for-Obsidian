import { App, Notice, TAbstractFile, TFile, TFolder } from 'obsidian';
import { citationUrl, noteParam } from './citationLink';
import type { CitationIndex } from './citationIndex';
import { citationLinksIn } from './links';

/**
 * After a note or folder is renamed, rewrites the `note` parameter of the
 * citation links that pointed to it. Obsidian updates wikilinks itself, but
 * citation links are URLs, so the plugin has to. Rewritten links take the
 * canonical encoded form.
 *
 * @returns the number of links updated
 */
export async function updateLinksAfterRename(
	app: App,
	index: CitationIndex,
	renamed: TAbstractFile,
	oldPath: string,
): Promise<number> {
	const oldNoExt = oldPath.replace(/\.md$/, '');
	const oldName = oldNoExt.split('/').pop() ?? oldNoExt;

	/** The new `note` value for an old one, or null if the link is not about the renamed item. */
	const newNote = (note: string): string | null => {
		const n = note.replace(/\.md$/, '');
		if (renamed instanceof TFolder) {
			return n.startsWith(`${oldPath}/`) ? renamed.path + n.slice(oldPath.length) : null;
		}
		if (renamed instanceof TFile && (n === oldNoExt || n === oldName)) return noteParam(app, renamed);
		return null;
	};

	let updated = 0;
	for (const { path } of index.linksNaming(renamed, oldPath)) {
		const citing = app.vault.getAbstractFileByPath(path);
		if (!(citing instanceof TFile)) continue;
		await app.vault.process(citing, (text) => {
			let result = '';
			let last = 0;
			for (const link of citationLinksIn(text)) {
				const note = link.target.note ? newNote(link.target.note) : null;
				if (note === null) continue;
				result += `${text.slice(last, link.from)}[${link.text}](${citationUrl({ ...link.target, note })})`;
				last = link.to;
				updated++;
			}
			return result + text.slice(last);
		});
		await index.indexFile(citing);
	}
	if (updated > 0) new Notice(`Updated ${updated} citation link${updated > 1 ? 's' : ''} to "${renamed.name}".`);
	return updated;
}
