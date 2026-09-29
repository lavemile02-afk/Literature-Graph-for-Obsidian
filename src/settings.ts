import { App, Plugin, PluginSettingTab, SecretComponent, SettingDefinitionItem } from 'obsidian';
import { LAYOUT_STYLES } from './layout';

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
	/** Property holding a work's title (used when the reference property is empty). */
	titleProperty: string;
	/** Always use the note name as the citation text. */
	useNoteNameAsCitation: boolean;
	/** Property holding a work's DOI, used to recognize works cited by DOI. */
	doiProperty: string;
	/** Look up bibliographic data on OpenAlex (network access). */
	openAlexEnabled: boolean;
	/** Contact email sent to OpenAlex (its "polite pool"); empty by default. */
	openAlexEmail: string;
	/** Name of the secret (Obsidian's secret storage) that holds an OpenAlex API key. */
	openAlexKeySecret: string;
	/** Generations shown by default in the literature graph: 0, 1 or 2. */
	graphGenerations: number;
	/** A work outside the vault is shown if at least this many works of the graph cite it. */
	graphMinCitations: number;
	/** Most nodes in the literature graph; 0: no limit. */
	graphMaxNodes: number;
	/** Forces of the graph's layout, by default (the graph's panel changes them for as long as it is open). */
	graphRepel: number;
	graphLinkDistance: number;
	graphCenter: number;
	/** Color groups of the literature graph, one per line: "query = color". */
	graphColorGroups: string;
	/** Style of layout of the graph: "default" or "atom". */
	graphLayout: string;
	/** Color of the works outside the vault (any CSS color); empty: from the theme. */
	graphOutsideColor: string;
	/** Color of the citations of a hovered work by others (any CSS color); empty: the theme's orange. */
	graphIncomingColor: string;
}

export const DEFAULT_SETTINGS: LiteratureGraphSettings = {
	literatureFolder: 'Documents',
	citationLanguage: 'en',
	citationTextProperty: 'Citation_texte',
	authorsProperty: 'Auteurs',
	yearProperty: 'Annee',
	titleProperty: 'Titre',
	useNoteNameAsCitation: false,
	doiProperty: 'DOI',
	openAlexEnabled: true,
	openAlexEmail: '',
	openAlexKeySecret: '',
	graphGenerations: 0,
	graphMinCitations: 1,
	graphMaxNodes: 3000,
	graphRepel: 90,
	graphLinkDistance: 60,
	graphCenter: 0.02,
	graphColorGroups: '',
	graphLayout: 'default',
	graphOutsideColor: '',
	graphIncomingColor: '',
};

export class LiteratureGraphSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly owner: Plugin & {
			onSettingsChanged: () => void;
			settings: LiteratureGraphSettings;
			saveSettings: () => Promise<void>;
		},
	) {
		super(app, owner);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await super.setControlValue(key, value);
		this.owner.onSettingsChanged();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Literature folder',
				desc: 'Folder that holds your literature notes: the works of the graph, whose reference lists are read. Leave empty to use the whole vault.',
				control: {
					type: 'folder',
					key: 'literatureFolder',
					placeholder: 'Documents',
				},
			},
			{
				name: 'Citation language',
				desc: 'Language of the labels of works, for example "Smith & Jones, 2020" or "Smith et Jones, 2020".',
				control: {
					type: 'dropdown',
					key: 'citationLanguage',
					options: { en: 'English', fr: 'French' },
				},
			},
			{
				type: 'group',
				heading: 'Works',
				items: [
					{
						name: 'Citation text property',
						desc: 'Property that holds the in-text citation of a work, such as "(Smith et al., 2020)". Works are labelled with it in the graph and the citations panel.',
						control: { type: 'text', key: 'citationTextProperty', placeholder: 'Citation_texte' },
					},
					{
						name: 'Authors property',
						desc: 'Property that holds the authors, as "Family, I., Family, I.". Used to label a work when the citation text property is empty, and to recognize it in reference lists.',
						control: { type: 'text', key: 'authorsProperty', placeholder: 'Auteurs' },
					},
					{
						name: 'Year property',
						desc: 'Property that holds the year of publication, to recognize a work in reference lists.',
						control: { type: 'text', key: 'yearProperty', placeholder: 'Annee' },
					},
					{
						name: 'Title property',
						desc: 'Property that holds the title, to recognize a work in reference lists (with the note\'s aliases, such as the original title of a translation).',
						control: { type: 'text', key: 'titleProperty', placeholder: 'Titre' },
					},
					{
						name: 'Always use the note name',
						desc: 'Label works with the name of their note, ignoring the properties above.',
						control: { type: 'toggle', key: 'useNoteNameAsCitation' },
					},
					{
						name: 'DOI property',
						desc: 'Property that holds the DOI of a work, to find its references and citations on OpenAlex and to recognize it when cited by DOI.',
						control: { type: 'text', key: 'doiProperty', placeholder: 'DOI' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Literature graph',
				items: [
					{
						name: 'Layout',
						desc: 'Default graph: every work repels the others, as in Obsidian\'s graph view. Atom graph: each work of the vault is a nucleus, alone at the center of a circle of the works it cites; atoms do not overlap. Can be changed in the graph for the time it stays open.',
						control: { type: 'dropdown', key: 'graphLayout', options: { ...LAYOUT_STYLES } },
					},
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
						desc: 'At most this many works in the graph; the most cited works outside the vault are kept. 0: no limit. Large graphs take longer to load (each work outside the vault is fetched once from OpenAlex, then kept) and to lay out; tens of thousands of works need a fast computer.',
						control: { type: 'number', key: 'graphMaxNodes', min: 0 },
					},
					{
						name: 'Repel force',
						desc: 'How strongly works push each other away (atoms, in the atom graph). Can be changed in the graph for the time it stays open.',
						control: { type: 'slider', key: 'graphRepel', min: 10, max: 300, step: 10 },
					},
					{
						name: 'Link distance',
						desc: 'Length of the citations (in the atom graph: the room between atoms). Can be changed in the graph for the time it stays open.',
						control: { type: 'slider', key: 'graphLinkDistance', min: 20, max: 200, step: 10 },
					},
					{
						name: 'Center force',
						desc: 'How strongly every work is pulled toward the middle: higher for a tighter, rounder graph, lower to spread it. Can be changed in the graph for the time it stays open.',
						control: { type: 'slider', key: 'graphCenter', min: 0, max: 0.2, step: 0.005 },
					},
					{
						name: 'Color groups',
						desc: 'One group per line, "query = color"; a note takes the color of the first group it matches. Queries: tag:#name, path:text, file:text, [property:value], [property], or text in the name or title. Colors: any CSS color (#d9a441, rgb(…), hsl(…)). Lines starting with // are ignored.',
						control: {
							type: 'textarea',
							key: 'graphColorGroups',
							placeholder: 'tag:#review = #d9a441\n[Type:Book] = rgb(120, 170, 220)',
						},
					},
					{
						name: 'Color of works outside the vault',
						desc: 'Any CSS color. Empty: the color of the notes blended with the background, so the works you have stand out; works of generation 2 are blended further.',
						control: { type: 'text', key: 'graphOutsideColor', placeholder: 'Theme color' },
					},
					{
						name: 'Color of citing works',
						desc: 'When you hover a work, the arrows of the works it cites take the accent color, and those of the works citing it take this color. Any CSS color. Empty: the theme\'s orange.',
						control: { type: 'text', key: 'graphIncomingColor', placeholder: 'Theme orange' },
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
					{
						name: 'OpenAlex API key',
						desc: 'Optional but recommended. Without a key, OpenAlex allows a small free daily budget shared by everyone on your network, which a large literature graph can use up. A free key (openalex.org) has its own budget. The key is kept in Obsidian\'s secret storage, not in the plugin settings.',
						render: (setting) => {
							setting.addComponent((el) =>
								new SecretComponent(this.app, el)
									.setValue(this.owner.settings.openAlexKeySecret)
									.onChange(async (value) => {
										this.owner.settings.openAlexKeySecret = value;
										await this.owner.saveSettings();
									}),
							);
						},
					},
				],
			},
		];
	}
}
