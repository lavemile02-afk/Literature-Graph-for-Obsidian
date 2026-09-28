import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { Plugin } from 'obsidian';
import { CITE_URL_PREFIX, parseCitationUrl } from './citation';
import type { CitationIndex } from './citationIndex';
import { markdownLinksInLine } from './links';

const BROKEN = 'literature-graph-cite-broken';

/**
 * Marks broken citation links (no note, and no DOI) in the reading view and
 * in the editor, as Obsidian marks links to missing notes.
 */
export function registerBrokenLinkMarks(plugin: Plugin, index: CitationIndex): void {
	const isBroken = (url: string): boolean => {
		const target = parseCitationUrl(url);
		return target !== null && index.resolve(target).kind === 'broken';
	};

	// Reading view.
	plugin.registerMarkdownPostProcessor((el) => {
		for (const a of Array.from(el.querySelectorAll('a.external-link'))) {
			const href = a.getAttribute('href') ?? '';
			if (href.startsWith(CITE_URL_PREFIX)) a.toggleClass(BROKEN, isBroken(href));
		}
	});

	// Editor: a mark on the text of each broken link of the visible lines.
	const mark = Decoration.mark({ class: BROKEN });
	const build = (view: EditorView): DecorationSet => {
		const builder = new RangeSetBuilder<Decoration>();
		for (const { from, to } of view.visibleRanges) {
			for (let pos = from; pos <= to; ) {
				const line = view.state.doc.lineAt(pos);
				if (line.text.includes(CITE_URL_PREFIX)) {
					for (const link of markdownLinksInLine(line.text)) {
						if (!link.url.startsWith(CITE_URL_PREFIX)) continue;
						// A readable URL with spaces needs angle brackets to be a link.
						const bracketless = /\s/.test(link.url) && line.text.charAt(link.from + link.text.length + 3) !== '<';
						if (!bracketless && !isBroken(link.url)) continue;
						const start = line.from + link.from + 1;
						builder.add(start, start + link.text.length, mark);
					}
				}
				pos = line.to + 1;
			}
		}
		return builder.finish();
	};
	const viewPlugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = build(view);
			}
			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged || update.transactions.some((t) => t.reconfigured)) {
					this.decorations = build(update.view);
				}
			}
		},
		{ decorations: (v) => v.decorations },
	);
	plugin.registerEditorExtension(viewPlugin);

	// When what exists changes (a note is created or renamed), redraw the marks.
	plugin.registerEvent(index.on('changed', () => plugin.app.workspace.updateOptions()));
}
