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
	/** Property holding a work's full reference, in APA style. */
	referenceProperty: string;
	/** Property holding a work's title (used when the reference property is empty). */
	titleProperty: string;
	/** Always use the note name as the citation text. */
	useNoteNameAsCitation: boolean;
	/** Property holding a work's DOI, used to recognize works cited by DOI. */
	doiProperty: string;
	/** Rewrite citation links when the cited note is renamed. */
	updateLinksOnRename: boolean;
	/** Look up bibliographic data on OpenAlex (network access). */
	openAlexEnabled: boolean;
	/** Contact email sent to OpenAlex (its "polite pool"); empty by default. */
	openAlexEmail: string;
	/** Generations shown by default in the literature graph: 0, 1 or 2. */
	graphGenerations: number;
	/** A work outside the vault is shown if at least this many works of the graph cite it. */
	graphMinCitations: number;
	/** Most nodes in the literature graph. */
	graphMaxNodes: number;
}

export const DEFAULT_SETTINGS: LiteratureGraphSettings = {
	literatureFolder: 'Documents',
	citationLanguage: 'en',
	citationTextProperty: 'Citation_texte',
	authorsProperty: 'Auteurs',
	yearProperty: 'Annee',
	referenceProperty: 'Citation',
	titleProperty: 'Titre',
	useNoteNameAsCitation: false,
	doiProperty: 'DOI',
	updateLinksOnRename: true,
	openAlexEnabled: true,
	openAlexEmail: '',
	graphGenerations: 0,
	graphMinCitations: 1,
	graphMaxNodes: 3000,
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
						name: 'Reference property',
						desc: 'Property that holds the full reference of a work, in APA style. Used by "Insert reference list".',
						control: { type: 'text', key: 'referenceProperty', placeholder: 'Citation' },
					},
					{
						name: 'Title property',
						desc: 'Property that holds the title. Used to build a short reference when the reference property is empty.',
						control: { type: 'text', key: 'titleProperty', placeholder: 'Titre' },
					},
					{
						name: 'Always use the note name',
						desc: 'Use the name of the cited note as the citation text, ignoring the properties above.',
						control: { type: 'toggle', key: 'useNoteNameAsCitation' },
					},
					{
						name: 'DOI property',
						desc: 'Property that holds the DOI of a work. A link that cites a DOI opens the note with that DOI, if there is one.',
						control: { type: 'text', key: 'doiProperty', placeholder: 'DOI' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Literature graph',
				items: [
					{
						name: 'Generations',
						desc: '0: the works of the literature folder. 1: also the works outside the vault that they cite (from OpenAlex). 2: also the works those cite. Can be changed in the graph for the time it stays open.',
						control: { type: 'dropdown', key: 'graphGenerations', options: { '0': '0', '1': '1', '2': '2' } },
					},
					{
						name: 'Minimum citations for works outside the vault',
						desc: 'A work outside the vault is shown only if at least this many works of the graph cite it. Can be changed in the graph for the time it stays open.',
						control: { type: 'number', key: 'graphMinCitations', min: 1 },
					},
					{
						name: 'Node limit',
						desc: 'At most this many works in the graph; the most cited works outside the vault are kept. Large graphs take longer to load and to lay out.',
						control: { type: 'number', key: 'graphMaxNodes', min: 100 },
					},
				],
			},
			{
				type: 'group',
				heading: 'Bibliographies',
				items: [
					{
						name: 'Use OpenAlex',
						desc: 'Look up the references of your works, and works outside your vault, on OpenAlex (api.openalex.org), a free and open index of scholarly works. Requests send DOIs and OpenAlex ids only. Answers are cached in the plugin folder, so they stay available offline.',
						control: { type: 'toggle', key: 'openAlexEnabled' },
					},
					{
						name: 'Contact email for OpenAlex',
						desc: 'Optional. OpenAlex asks for an email address to contact you if a problem occurs, and answers such requests faster. It is sent with every request.',
						control: { type: 'text', key: 'openAlexEmail', placeholder: 'you@example.org' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Advanced',
				items: [
					{
						name: 'Update links when a note is renamed',
						desc: 'Rewrite the citation links that point to a note when it is renamed or moved. Obsidian does this for wikilinks, but not for citation links.',
						control: { type: 'toggle', key: 'updateLinksOnRename' },
					},
				],
			},
		];
	}
}
