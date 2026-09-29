import { App, Modal, TFile } from 'obsidian';
import type { DuplicateGroup } from './duplicates';
import { openFileAtLine } from './navigation';

/** Lists the notes that may be the same work twice; a click opens a note. */
export class DuplicatesModal extends Modal {
	constructor(
		app: App,
		private readonly groups: DuplicateGroup[],
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Duplicate works');
		const el = this.contentEl;
		if (this.groups.length === 0) {
			el.createEl('p', { text: 'No two notes of the literature folder seem to be the same work.' });
			return;
		}
		el.createEl('p', {
			cls: 'setting-item-description',
			text: 'Notes that may be the same work: same DOI, or same first author, year and title. Notes with different DOIs are never listed.',
		});
		for (const group of this.groups) {
			const box = el.createDiv({ cls: 'literature-graph-duplicates-group' });
			box.createDiv({
				cls: 'literature-graph-duplicates-reason',
				text: group.reason === 'doi' ? 'Same DOI' : 'Same first author, year and title',
			});
			for (const path of group.paths) {
				const file = this.app.vault.getAbstractFileByPath(path);
				const link = box.createDiv({ cls: 'literature-graph-duplicates-note', text: path });
				link.addEventListener('click', () => {
					if (!(file instanceof TFile)) return;
					this.close();
					void openFileAtLine(this.app, file, 0, false);
				});
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
