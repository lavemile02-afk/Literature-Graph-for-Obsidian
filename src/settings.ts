import { PluginSettingTab, SettingDefinitionItem } from 'obsidian';

export interface LiteratureGraphSettings {
	/** Folder that holds the literature notes (empty = whole vault). */
	literatureFolder: string;
}

export const DEFAULT_SETTINGS: LiteratureGraphSettings = {
	literatureFolder: 'Documents',
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
		];
	}
}
