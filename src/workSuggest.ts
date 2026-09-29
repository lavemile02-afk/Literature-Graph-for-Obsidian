import { AbstractInputSuggest, App } from 'obsidian';
import type { GraphNode } from './graphData';
import { searchWorks } from './search';

/** Suggestions of the graph's search field: the works matching the typed text. */
export class WorkSuggest extends AbstractInputSuggest<GraphNode> {
	constructor(
		app: App,
		private readonly inputEl: HTMLInputElement,
		private readonly works: () => GraphNode[],
		private readonly choose: (work: GraphNode) => void,
	) {
		super(app, inputEl);
	}

	protected getSuggestions(query: string): GraphNode[] {
		return searchWorks(query, this.works());
	}

	renderSuggestion(work: GraphNode, el: HTMLElement): void {
		el.createDiv({ text: work.label });
		if (work.title) el.createDiv({ cls: 'literature-graph-search-title', text: work.title });
	}

	selectSuggestion(work: GraphNode): void {
		this.setValue(work.label);
		this.close();
		this.choose(work);
	}
}
