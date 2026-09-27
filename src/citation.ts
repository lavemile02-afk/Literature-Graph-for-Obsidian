import type { ObsidianProtocolData } from 'obsidian';

/** Protocol action handled by the plugin: obsidian://cite?... */
export const CITE_ACTION = 'cite';

/** What a citation link points to, read from its URL parameters. */
export interface CitationTarget {
	/** Note name (resolved like a wikilink) or path from the vault root. */
	note?: string;
	/** Start of the cited passage, copied word for word from the note. */
	q?: string;
	/** End of the cited passage (optional). */
	qe?: string;
	/** Which occurrence of the passage, starting at 1 (optional). */
	occ?: number;
	/** DOI of the cited work (required when the work has no note). */
	doi?: string;
}

const KNOWN_PARAMS = new Set(['action', 'note', 'q', 'qe', 'occ', 'doi']);

function value(params: ObsidianProtocolData, key: string): string | undefined {
	const v = params[key];
	return v === undefined || v === '' ? undefined : v;
}

/**
 * Reads a citation target from the parameters of an obsidian://cite URL.
 *
 * `q` is always the last parameter, so that a readable (unencoded) link
 * whose passage contains "&" can still be parsed: any unknown parameter that
 * follows is treated as the rest of the passage.
 */
export function parseCitationParams(params: ObsidianProtocolData): CitationTarget {
	let q = value(params, 'q');
	if (q !== undefined) {
		let afterQ = false;
		for (const key of Object.keys(params)) {
			if (key === 'q') {
				afterQ = true;
			} else if (afterQ && !KNOWN_PARAMS.has(key)) {
				const rest = params[key];
				q += rest === 'true' || rest === '' ? `&${key}` : `&${key}=${rest}`;
			}
		}
	}
	const occ = Number.parseInt(value(params, 'occ') ?? '', 10);
	return {
		note: value(params, 'note'),
		q,
		qe: value(params, 'qe'),
		occ: Number.isFinite(occ) && occ > 0 ? occ : undefined,
		doi: value(params, 'doi'),
	};
}
