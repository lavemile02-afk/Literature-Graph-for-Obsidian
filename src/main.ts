import { Plugin } from 'obsidian';
import { CITE_ACTION, parseCitationParams } from './citation';
import { registerCitationClicks } from './clicks';
import { openCitation } from './navigation';
import {
	DEFAULT_SETTINGS,
	LiteratureGraphSettings,
	LiteratureGraphSettingTab,
} from './settings';

export default class LiteratureGraphPlugin extends Plugin {
	settings!: LiteratureGraphSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new LiteratureGraphSettingTab(this.app, this));

		this.registerObsidianProtocolHandler(CITE_ACTION, (params) => {
			void openCitation(this.app, parseCitationParams(params));
		});
		registerCitationClicks(this);
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<LiteratureGraphSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
