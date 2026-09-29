import { titleOverlap, VaultWork } from './bibliography';

/**
 * Notes of the vault that may be the same work twice: same DOI, or same
 * first author, year and title. Two notes with different DOIs are never
 * taken for one work (two parts of a study, a book and one of its chapters).
 */

export interface DuplicateGroup {
	/** Paths of the notes, sorted. */
	paths: string[];
	/** Why they look like one work. */
	reason: 'doi' | 'title';
}

/**
 * Share of the words of each title found in the other, for two titles to be
 * the same: high, because the parts of a study ("I. …", "II. …") share most
 * of their words.
 */
const SAME_TITLE = 0.9;

export function findDuplicates(works: { path: string; work: VaultWork }[]): DuplicateGroup[] {
	const groups: DuplicateGroup[] = [];
	const grouped = new Set<string>();

	const byDoi = new Map<string, string[]>();
	for (const { path, work } of works) {
		if (!work.doi) continue;
		const doi = work.doi.toLowerCase();
		byDoi.set(doi, [...(byDoi.get(doi) ?? []), path]);
	}
	for (const paths of byDoi.values()) {
		if (paths.length < 2) continue;
		groups.push({ paths: [...paths].sort(), reason: 'doi' });
		for (const p of paths) grouped.add(p);
	}

	const byAuthorYear = new Map<string, { path: string; work: VaultWork }[]>();
	for (const w of works) {
		const first = w.work.authors[0];
		if (!first || !w.work.year || !w.work.title || grouped.has(w.path)) continue;
		const key = `${first}|${w.work.year}`;
		byAuthorYear.set(key, [...(byAuthorYear.get(key) ?? []), w]);
	}
	for (const candidates of byAuthorYear.values()) {
		const taken = new Set<string>();
		for (const [i, a] of candidates.entries()) {
			if (taken.has(a.path)) continue;
			const same = candidates.slice(i + 1).filter((b) => {
				if (taken.has(b.path)) return false;
				if (a.work.doi && b.work.doi) return false;
				return titleOverlap(a.work.title, b.work.title) >= SAME_TITLE && titleOverlap(b.work.title, a.work.title) >= SAME_TITLE;
			});
			if (same.length === 0) continue;
			const paths = [a.path, ...same.map((b) => b.path)];
			for (const p of paths) taken.add(p);
			groups.push({ paths: paths.sort(), reason: 'title' });
		}
	}
	return groups.sort((x, y) => (x.paths[0] ?? '').localeCompare(y.paths[0] ?? ''));
}
