import { HoverParent, HoverPopover, Keymap, Plugin, TFile } from 'obsidian';
import { parseCitationUrl } from './citation';
import { citationText } from './citationLink';
import type { CitationIndex } from './citationIndex';
import { citationLinkAt } from './clicks';
import type { OpenAlexClient } from './openalex';
import { findPassage, TextRange } from './passage';
import type { LiteratureGraphSettings } from './settings';

/** Characters of context shown around a passage. */
const CONTEXT = 240;
/** Longest passage shown whole; longer ones keep their start and end. */
const MAX_PASSAGE = 700;

/** Markdown made readable as plain text: no marks, tags, link syntax or extra spaces. */
export function plainText(markdown: string): string {
	return markdown
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]*)\]\((?:<[^>]*>|[^)]*)\)/g, '$1')
		.replace(/<br\s*\/?>/gi, ' ')
		.replace(/<[^>]+>/g, '')
		.replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
		.replace(/[*_`~]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * The passage and some context around it, on the passage's lines, as plain
 * text: what a hover preview shows. (Converted notes keep a paragraph or a
 * list item on one line, so the context stops at the line's ends.)
 */
export function passageExcerpt(text: string, range: TextRange): { before: string; passage: string; after: string } {
	const lineStart = text.lastIndexOf('\n', range.from - 1) + 1;
	const nextBreak = text.indexOf('\n', Math.max(range.from, range.to - 1));
	const lineEnd = nextBreak < 0 ? text.length : nextBreak;
	let from = Math.max(lineStart, range.from - CONTEXT);
	let to = Math.min(lineEnd, range.to + CONTEXT);
	// Start and end on word boundaries.
	if (from > lineStart && from < range.from) from = text.indexOf(' ', from) + 1 || from;
	if (to < lineEnd && to > range.to) to = text.lastIndexOf(' ', to) > range.to ? text.lastIndexOf(' ', to) : to;

	let passage = plainText(text.slice(range.from, range.to));
	if (passage.length > MAX_PASSAGE) {
		passage = `${passage.slice(0, MAX_PASSAGE / 2).trimEnd()} … ${passage.slice(-MAX_PASSAGE / 3).trimStart()}`;
	}
	const before = plainText(text.slice(from, range.from));
	const after = plainText(text.slice(range.to, to));
	return {
		before: before && from > lineStart ? `… ${before}` : before,
		passage,
		after: after && to < lineEnd ? `${after} …` : after,
	};
}

/**
 * Hover previews of citation links, like Obsidian's page previews: the cited
 * work and the passage in its context. In the reading view they appear on
 * hover; in the editor, with Ctrl/Cmd held, as for Obsidian's own links.
 */
export function registerCitationHover(
	plugin: Plugin,
	index: CitationIndex,
	openAlex: OpenAlexClient,
	settings: () => LiteratureGraphSettings,
): void {
	const parent: HoverParent = { hoverPopover: null };
	let target: HTMLElement | null = null;

	const onOver = (evt: MouseEvent) => {
		const el = evt.target instanceof Element ? evt.target : null;
		const found = el ? citationLinkAt(el) : null;
		if (!found || found.element === target) return;
		if (found.inEditor && !Keymap.isModEvent(evt)) return;
		const citation = parseCitationUrl(found.url);
		if (!citation) return;
		target = found.element;
		const popover = new HoverPopover(parent, found.element, 300);
		popover.register(() => {
			if (target === found.element) target = null;
		});
		const box = popover.hoverEl.createDiv({ cls: 'literature-graph-hover' });
		void fill(box, citation);
	};

	const fill = async (box: HTMLElement, citation: NonNullable<ReturnType<typeof parseCitationUrl>>) => {
		const s = settings();
		const work = index.resolve(citation);
		if (work.kind === 'note') {
			const file: TFile = work.file;
			const title: unknown = plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[s.titleProperty];
			box.createDiv({ cls: 'literature-graph-hover-title', text: citationText(plugin.app, file, s) });
			box.createDiv({ cls: 'literature-graph-hover-subtitle', text: typeof title === 'string' ? title : file.basename });
			if (!citation.q) return;
			const text = await plugin.app.vault.cachedRead(file);
			const range = findPassage(text, citation.q, citation.qe, citation.occ);
			if (!range) {
				box.createDiv({ cls: 'literature-graph-hover-status is-error', text: 'Passage not found in the note.' });
				return;
			}
			const excerpt = passageExcerpt(text, range);
			const p = box.createEl('p', { cls: 'literature-graph-hover-excerpt' });
			if (excerpt.before) p.appendText(`${excerpt.before} `);
			p.createEl('mark', { text: excerpt.passage });
			if (excerpt.after) p.appendText(` ${excerpt.after}`);
			if (range.approximate) {
				box.createDiv({ cls: 'literature-graph-hover-status', text: 'The passage was changed: this is the closest text.' });
			}
		} else if (work.kind === 'doi') {
			const cached = openAlex.cachedIdForDoi(work.doi);
			const known = cached ? openAlex.cachedWork(cached) : await openAlex.workByDoi(work.doi);
			box.createDiv({ cls: 'literature-graph-hover-title', text: known?.title ?? `https://doi.org/${work.doi}` });
			box.createDiv({ cls: 'literature-graph-hover-subtitle', text: 'Not in the vault: the link opens its DOI.' });
		} else {
			box.createDiv({
				cls: 'literature-graph-hover-status is-error',
				text: `Cited work not found: ${citation.note ?? '(no note or DOI in the link)'}.`,
			});
		}
	};

	const listen = (doc: Document) => plugin.registerDomEvent(doc, 'mouseover', onOver);
	listen(document);
	plugin.registerEvent(plugin.app.workspace.on('window-open', (win) => listen(win.doc)));
}
