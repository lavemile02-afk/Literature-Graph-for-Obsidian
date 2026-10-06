import { App, Plugin, PluginSettingTab, SecretComponent, SettingDefinitionItem } from 'obsidian';
import { IDLE_CHOICES } from './animations';
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
	/** Property of a literature note that lists its keywords (written by "Write keywords to notes", editable by the user). */
	keywordsProperty: string;
	/** Look up bibliographic data on OpenAlex (network access). */
	openAlexEnabled: boolean;
	/** Contact email sent to OpenAlex (its "polite pool"); empty by default. */
	openAlexEmail: string;
	/** Name of the secret (Obsidian's secret storage) that holds an OpenAlex API key. */
	openAlexKeySecret: string;
	/** Depth shown by default in the literature graph: 0, 1 or 2. */
	graphDepth: number;
	/** A work outside the vault is shown if at least this many works of the graph cite it. */
	graphMinCitations: number;
	/** Most nodes in the literature graph; 0: no limit. */
	graphMaxNodes: number;
	/** Forces of the graph's layout, by default (the graph's panel changes them for as long as it is open). */
	graphRepel: number;
	graphLinkDistance: number;
	graphCenter: number;
	/** How strongly works close in meaning draw together, in the Meaning layout. */
	graphMeaningAttraction: number;
	/** Color groups of the literature graph, one per line: "query = color". */
	graphColorGroups: string;
	/** How the works are colored: "groups" (color groups) or "meaning" (their words, see `meaning.ts`). */
	graphColorBy: string;
	/** Size of the points of the graph, times their usual size (0.25 to 3). */
	graphPointScale: number;
	/** Topic colors: brightness, from -20 (darker) to 20 (lighter) around the theme's, and intensity (saturation), in percent. */
	graphTopicBrightness: number;
	graphTopicIntensity: number;
	/** Style of layout of the graph: "default" or "atom". */
	graphLayout: string;
	/** Color of the works outside the vault (any CSS color); empty: from the theme. */
	graphOutsideColor: string;
	/** Color of the citations of a hovered work by others (any CSS color); empty: the theme's orange. */
	graphIncomingColor: string;
	/** Whether an animation plays after a while without input. */
	graphIdleEnabled: boolean;
	/** Animation after a while without input: a key of IDLE_CHOICES ("random": a different one each time). */
	graphIdleAnimation: string;
	/** Seconds without any input before the idle animation starts. */
	graphIdleDelay: number;
	/** Speed of the idle animation, from 1 to 20 (5: its own pace). */
	graphRotationSpeed: number;
	/** In the idle animation, the works appear one by one. */
	graphAppearOneByOne: boolean;
	/** Also show the notes outside the literature folder linked by citation links. */
	graphAllNotes: boolean;
	/** The cited-by graph: the works citing the vault's works rather than those they cite (see `graphData.ts`). */
	graphCitedBy: boolean;
	/** Citations of the graph found in citation links, reference lists, OpenAlex. */
	graphEdgeLinks: boolean;
	graphEdgeBibliographies: boolean;
	graphEdgeOpenAlex: boolean;
	/** Template of the note of a work outside the vault (see `workNote.ts`); empty: the default template. */
	noteTemplate: string;
	/** Folder of the vault where free PDFs are downloaded; empty: where Obsidian puts attachments. */
	pdfFolder: string;
	/** Where "Export reading suggestions" writes its file (a path in the vault); empty: in the plugin folder. */
	suggestionsFile: string;
}

export const DEFAULT_SETTINGS: LiteratureGraphSettings = {
	literatureFolder: 'Literature',
	citationLanguage: 'en',
	citationTextProperty: 'citation-text',
	authorsProperty: 'authors',
	yearProperty: 'year',
	titleProperty: 'title',
	useNoteNameAsCitation: false,
	doiProperty: 'doi',
	keywordsProperty: 'keywords',
	openAlexEnabled: true,
	openAlexEmail: '',
	openAlexKeySecret: '',
	graphDepth: 0,
	graphMinCitations: 1,
	graphMaxNodes: 3000,
	graphRepel: 90,
	graphLinkDistance: 60,
	graphCenter: 0.02,
	graphMeaningAttraction: 1,
	graphColorGroups: '',
	graphColorBy: 'groups',
	graphPointScale: 1,
	graphTopicBrightness: 0,
	graphTopicIntensity: 100,
	graphLayout: 'default',
	graphOutsideColor: '',
	graphIncomingColor: '',
	graphIdleEnabled: true,
	graphIdleAnimation: 'sphere',
	graphIdleDelay: 10,
	graphRotationSpeed: 5,
	graphAppearOneByOne: true,
	graphAllNotes: false,
	graphCitedBy: false,
	graphEdgeLinks: true,
	graphEdgeBibliographies: true,
	graphEdgeOpenAlex: true,
	noteTemplate: '',
	pdfFolder: '',
	suggestionsFile: '',
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
					placeholder: 'Literature',
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
						control: { type: 'text', key: 'citationTextProperty', placeholder: 'citation-text' },
					},
					{
						name: 'Authors property',
						desc: 'Property that holds the authors, as "Family, I., Family, I.". Used to label a work when the citation text property is empty, and to recognize it in reference lists.',
						control: { type: 'text', key: 'authorsProperty', placeholder: 'authors' },
					},
					{
						name: 'Year property',
						desc: 'Property that holds the year of publication, to recognize a work in reference lists.',
						control: { type: 'text', key: 'yearProperty', placeholder: 'year' },
					},
					{
						name: 'Title property',
						desc: 'Property that holds the title, to recognize a work in reference lists (with the note\'s aliases, such as the original title of a translation).',
						control: { type: 'text', key: 'titleProperty', placeholder: 'title' },
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
					{
						name: 'Keywords property',
						desc: 'Property that lists the keywords of a work. The command "Write keywords to notes" fills it from OpenAlex where it is empty; you can edit it freely, and your keywords count in the work\'s meaning, for colors and the Meaning layout.',
						control: { type: 'text', key: 'keywordsProperty', placeholder: 'keywords' },
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
						name: 'Depth',
						desc: '0: the works of the literature folder. 1: also the works outside the vault that they cite (from OpenAlex). 2: also the works those cite. Can be changed in the graph for the time it stays open.',
						control: { type: 'dropdown', key: 'graphDepth', options: { '0': '0', '1': '1', '2': '2' } },
					},
					{
						name: 'Minimum citations for works outside the vault',
						desc: 'A work outside the vault is shown only if at least this many works of the graph cite it; works of the vault are always shown. Changing it in the graph changes this setting too.',
						control: { type: 'number', key: 'graphMinCitations', min: 1 },
					},
					{
						name: 'Node limit',
						desc: 'At most this many works in the graph; the most cited works outside the vault are kept. 0: no limit. Large graphs take longer to load (each work outside the vault is fetched once from OpenAlex, then kept) and to lay out; tens of thousands of works need a fast computer.',
						control: { type: 'number', key: 'graphMaxNodes', min: 0 },
					},
					{
						name: 'All notes of the vault',
						desc: 'Also show the notes outside the literature folder that cite works with citation links (such as drafts or course notes), and the notes they cite that way. Only citation links count, never wikilinks. Can be changed in the graph for the time it stays open.',
						control: { type: 'toggle', key: 'graphAllNotes' },
					},
					{
						name: 'Cited by graph',
						desc: 'At depth 1 and 2, show the works outside the vault that cite the works of the vault (often newer literature, listed once by OpenAlex), instead of the works they cite. The minimum number of citations is then how many works of the vault they cite. Can be changed in the graph.',
						control: { type: 'toggle', key: 'graphCitedBy' },
					},
					{
						name: 'Citations from citation links',
						desc: 'Draw the citations written as citation links to a passage. Can be changed in the graph for the time it stays open.',
						control: { type: 'toggle', key: 'graphEdgeLinks' },
					},
					{
						name: 'Citations from reference lists',
						desc: 'Draw the citations found in the reference lists of your notes (and show their works without a DOI). Can be changed in the graph for the time it stays open.',
						control: { type: 'toggle', key: 'graphEdgeBibliographies' },
					},
					{
						name: 'Citations from OpenAlex',
						desc: 'Draw the citations known to OpenAlex (the references of works with a DOI). Can be changed in the graph for the time it stays open.',
						control: { type: 'toggle', key: 'graphEdgeOpenAlex' },
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
						name: 'Point size',
						desc: 'Size of the works in the graph, times their usual size. Also in the graph\'s panel; kept for every graph.',
						control: { type: 'slider', key: 'graphPointScale', min: 0.25, max: 3, step: 0.05 },
					},
					{
						name: 'Center force',
						desc: 'How strongly every work is pulled toward the middle: higher for a tighter, rounder graph, lower to spread it. Can be changed in the graph for the time it stays open.',
						control: { type: 'slider', key: 'graphCenter', min: 0, max: 0.2, step: 0.005 },
					},
					{
						name: 'Meaning attraction',
						desc: 'Meaning layout: how strongly works close in meaning draw together (the closer in meaning, the stronger), times the usual strength. Can be changed in the graph for the time it stays open.',
						control: { type: 'slider', key: 'graphMeaningAttraction', min: 0, max: 5, step: 0.1 },
					},
				],
			},
			{
				type: 'group',
				heading: 'Colors',
				items: [
					{
						name: 'Color by',
						desc: 'Color groups, or topic: each work takes a color from its meaning (the words of its note, or its title, topics, keywords and abstract on OpenAlex), all around the color wheel; the more two works differ, compared with all the works of the graph, the further apart their hues. Also chosen in the graph\'s settings panel.',
						control: { type: 'dropdown', key: 'graphColorBy', options: { groups: 'Color groups', meaning: 'Meaning' } },
					},
					{
						name: 'Meaning brightness',
						desc: 'Coloring by meaning: darker (left) or lighter (right) than the brightness chosen for your theme.',
						control: { type: 'slider', key: 'graphTopicBrightness', min: -20, max: 20, step: 1 },
					},
					{
						name: 'Meaning intensity',
						desc: 'Coloring by meaning: how vivid the colors are, in percent (lower for softer colors).',
						control: { type: 'slider', key: 'graphTopicIntensity', min: 20, max: 130, step: 5 },
					},
					{
						name: 'Color groups',
						desc: 'Coloring by color groups: one group per line, "query = color"; a note takes the color of the first group it matches. Queries: tag:#name, path:text, file:text, [property:value], [property], or text in the name or title. Colors: any CSS color (#d9a441, rgb(…), hsl(…)). Lines starting with // are ignored.',
						control: {
							type: 'textarea',
							key: 'graphColorGroups',
							placeholder: 'tag:#review = #d9a441\n[Type:Book] = rgb(120, 170, 220)',
						},
					},
					{
						name: 'Color of works outside the vault',
						desc: 'Coloring by color groups: any CSS color. Empty: the color of the notes blended with the background, so the works you have stand out; works at depth 2 are blended further. (By meaning, works outside the vault keep their color, darker.)',
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
				heading: 'Idle animations',
				items: [
					{
						name: 'Idle animations',
						desc: 'Turn the graph into an animation after a while without any click in Obsidian; a click on the graph brings the flat graph back (clicks in its panels do not). You can zoom and hover works while it plays. Never when your system asks for reduced motion.',
						control: { type: 'toggle', key: 'graphIdleEnabled' },
					},
					{
						name: 'Idle animation',
						desc: 'Which animation: a rotating sphere, works drifting freely, orbits, a wave, a braid..., or a random one, different each time. Also chosen in the graph\'s display panel.',
						control: { type: 'dropdown', key: 'graphIdleAnimation', options: { ...IDLE_CHOICES } },
					},
					{
						name: 'Idle delay',
						desc: 'When idle animations are on: seconds without any click before the animation starts (3 at least).',
						control: { type: 'number', key: 'graphIdleDelay', min: 3 },
					},
					{
						name: 'Animation speed',
						desc: 'How fast the idle animation moves.',
						control: { type: 'slider', key: 'graphRotationSpeed', min: 1, max: 20, step: 1 },
					},
					{
						name: 'Works appear one by one',
						desc: 'In the idle animation, the graph starts empty and the works appear one by one, growing out of the work that cites them: the works of the vault first, then the others, oldest first.',
						control: { type: 'toggle', key: 'graphAppearOneByOne' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Works outside the vault',
				items: [
					{
						name: 'Template of new notes',
						desc: 'Clicking a work outside the vault opens its note-to-be, filled from OpenAlex; it becomes a note of the literature folder as soon as you write in it or change a property. Fields: {{title}}, {{citationText}} (in-text citation), {{citation}} (APA reference), {{authors}}, {{year}}, {{type}}, {{journal}}, {{volume}}, {{issue}}, {{pages}}, {{publisher}}, {{issn}}, {{doi}}, {{url}}, {{language}}, {{abstract}}. In a property line such as Title: "{{title}}", an empty value leaves the property empty. Empty template: a simple default one.',
						control: {
							type: 'textarea',
							key: 'noteTemplate',
							placeholder: '---\ntitle: "{{title}}"\nauthors: "{{authors}}"\nyear: "{{year}}"\ndoi: "{{doi}}"\n---\n{{abstract}}',
						},
					},
					{
						name: 'PDF folder',
						desc: 'Folder of the vault where "Download PDF" saves the free PDFs of works. Empty: where Obsidian puts attachments (Settings, Files and links).',
						control: { type: 'text', key: 'pdfFolder', placeholder: 'Literature/PDF' },
					},
					{
						name: 'Reading suggestions file',
						desc: 'Where the command "Export reading suggestions" writes the 1000 most relevant works outside the vault, one per line (JSON Lines), for AI agents and other programs. A path in the vault, hidden folders included. Empty: reading-suggestions.jsonl in the plugin folder.',
						control: { type: 'text', key: 'suggestionsFile', placeholder: 'reading-suggestions.jsonl' },
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
