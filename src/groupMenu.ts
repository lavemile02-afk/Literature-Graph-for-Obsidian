import { AbstractInputSuggest, App, FuzzySuggestModal, Menu } from 'obsidian';
import { QueryData, querySuggestions } from './groupQueries';

/** A list to pick one value from, searched by typing. */
class PickModal extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		private readonly items: string[],
		placeholder: string,
		private readonly onPick: (item: string) => void,
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems(): string[] {
		return this.items;
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string): void {
		this.onPick(item);
	}
}

/** Shown first in the list of a property's values: any value (the query "[Type]"). */
const ANY_VALUE = '(any value)';

/**
 * The menu of the "New group" button: the kind of query, then its value
 * picked from the notes of the graph, so that no query has to be typed.
 * `add` receives the query written for it; an empty query (for a note name
 * or a text) is left to be typed, with suggestions.
 */
export function showNewGroupMenu(app: App, event: MouseEvent, data: () => QueryData, add: (query: string) => void): void {
	const menu = new Menu();
	menu.addItem((item) =>
		item
			.setTitle('Tag…')
			.setIcon('tag')
			.onClick(() => new PickModal(app, data().tags, 'Tag', (tag) => add(`tag:#${tag}`)).open()),
	);
	menu.addItem((item) =>
		item
			.setTitle('Property…')
			.setIcon('list')
			.onClick(() => {
				const properties = data().properties;
				new PickModal(app, [...properties.keys()], 'Property', (key) => {
					const values = properties.get(key) ?? [];
					new PickModal(app, [ANY_VALUE, ...values], `Value of ${key}`, (value) =>
						add(value === ANY_VALUE ? `[${key}]` : `[${key}:${value}]`),
					).open();
				}).open();
			}),
	);
	menu.addItem((item) =>
		item
			.setTitle('Folder…')
			.setIcon('folder')
			.onClick(() => new PickModal(app, data().folders, 'Folder', (folder) => add(`path:${folder}`)).open()),
	);
	menu.addItem((item) =>
		item
			.setTitle('Note name')
			.setIcon('file-text')
			.onClick(() => add('file:')),
	);
	menu.addItem((item) =>
		item
			.setTitle('Text in the name or title')
			.setIcon('type')
			.onClick(() => add('')),
	);
	menu.showAtMouseEvent(event);
}

/**
 * Suggestions in a group's query field while it is typed (see
 * `querySuggestions`): tags after "tag:", properties after "[", their values
 * after "[Type:", folders after "path:".
 */
export class QuerySuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		private readonly inputEl: HTMLInputElement,
		private readonly data: () => QueryData,
	) {
		super(app, inputEl);
	}

	protected getSuggestions(query: string): string[] {
		return querySuggestions(query, this.data());
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string): void {
		this.setValue(value);
		// Tell the field it changed (the group is saved), and go on suggesting
		// when the query is not complete yet ("[Type:" leads to its values).
		this.inputEl.dispatchEvent(new Event('input'));
		if (/[:[#]$/.test(value)) this.open();
		else this.close();
	}
}
