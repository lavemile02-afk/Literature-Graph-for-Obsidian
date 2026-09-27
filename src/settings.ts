import { PluginSettingTab, SettingDefinitionItem } from 'obsidian';

export type CitationLanguage = 'en' | 'fr';

export interface LiteratureGraphSettings {
	/** Folder that holds the literature notes (empty = whole vault). */
	literatureFolder: string;
	/** Language of the citations the plugin writes ("et al." forms, "&" or "et"). */
	citationLanguage: CitationLanguage;
	/** Property holding a work's in-text citation, e.g. "(Author et al., 2016)". */
	citationTextProperty: string;
	/** Property holding a work's authors, as "Family, I., Family, I.". */
	authorsProperty: string;
	/** Property holding a work's year. */
	yearProperty: string;
	/** Always use the note name as the citation text. */
	useNoteNameAsCitation: boolean;
}

export const DEFAULT_SETTINGS: LiteratureGraphSettings = {
	literatureFolder: 'Documents',
	citationLanguage: 'en',
	citationTextProperty: 'Citation_texte',
	authorsProperty: 'Auteurs',
	yearProperty: 'Annee',
	useNoteNameAsCitation: false,
};

export class LiteratureGraphSettingTab extends PluginSettingTab {
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Literature folder',
				desc: 'Folder that holds your literature notes. Leave empty to use the whole vault.',
				control: {
					type: 'folder',
					key: 'literatureFolder',
					placeholder: 'Documents',
				},
			},
			{
				name: 'Citation language',
				desc: 'Language of the citations the plugin writes, for example "Smith & Jones, 2020" or "Smith et Jones, 2020".',
				control: {
					type: 'dropdown',
					key: 'citationLanguage',
					options: { en: 'English', fr: 'French' },
				},
			},
			{
				type: 'group',
				heading: 'Citations',
				items: [
					{
						name: 'Citation text property',
						desc: 'Property that holds the in-text citation of a work, such as "(Smith et al., 2020)". Copied citation links use it as their text.',
						control: { type: 'text', key: 'citationTextProperty', placeholder: 'Citation_texte' },
					},
					{
						name: 'Authors property',
						desc: 'Property that holds the authors, as "Family, I., Family, I.". Used to build the citation text when the citation text property is empty.',
						control: { type: 'text', key: 'authorsProperty', placeholder: 'Auteurs' },
					},
					{
						name: 'Year property',
						desc: 'Property that holds the year of publication.',
						control: { type: 'text', key: 'yearProperty', placeholder: 'Annee' },
					},
					{
						name: 'Always use the note name',
						desc: 'Use the name of the cited note as the citation text, ignoring the properties above.',
						control: { type: 'toggle', key: 'useNoteNameAsCitation' },
					},
				],
			},
		];
	}
}
