import type { ObsidianProtocolData } from 'obsidian';

/** Protocol action handled by the plugin: obsidian://cite?... */
export const CITE_ACTION = 'cite';

/** Every citation URL starts with this prefix. */
export const CITE_URL_PREFIX = `obsidian://${CITE_ACTION}?`;

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

const KNOWN_PARAMS = ['note', 'q', 'qe', 'occ', 'doi'];

function toTarget(get: (key: string) => string | undefined): CitationTarget {
	const nonEmpty = (key: string) => {
		const v = get(key)?.trim();
		return v === undefined || v === '' ? undefined : v;
	};
	const occ = Number.parseInt(nonEmpty('occ') ?? '', 10);
	return {
		note: nonEmpty('note'),
		q: nonEmpty('q'),
		qe: nonEmpty('qe'),
		occ: Number.isFinite(occ) && occ > 0 ? occ : undefined,
		doi: nonEmpty('doi'),
	};
}

/** Decodes percent-escapes, leaving a stray "%" (as in "40%") as it is. */
function safeDecode(text: string): string {
	try {
		return decodeURIComponent(text.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
	} catch {
		return text;
	}
}

/**
 * Reads a citation target from a full obsidian://cite URL, encoded or
 * readable. Returns null if the URL is not a citation link.
 *
 * In the readable form the passage may contain "&", so the query is not
 * split on every "&": a value runs until the next "&" that starts a known
 * parameter ("&q=", "&occ=", ...).
 */
export function parseCitationUrl(url: string): CitationTarget | null {
	if (!url.startsWith(CITE_URL_PREFIX)) return null;
	const query = url.slice(CITE_URL_PREFIX.length);
	const boundary = new RegExp(`(?:^|&)(${KNOWN_PARAMS.join('|')})=`, 'g');
	const starts: { key: string; start: number; valueStart: number }[] = [];
	let match: RegExpExecArray | null;
	while ((match = boundary.exec(query)) !== null) {
		starts.push({
			key: match[1] ?? '',
			start: match.index,
			valueStart: match.index + match[0].length,
		});
	}
	const values = new Map<string, string>();
	starts.forEach((s, i) => {
		const end = starts[i + 1]?.start ?? query.length;
		if (!values.has(s.key)) values.set(s.key, safeDecode(query.slice(s.valueStart, end)));
	});
	return toTarget((key) => values.get(key));
}

/**
 * Reads a citation target from the parameters Obsidian passes to the
 * protocol handler (a link clicked in another application).
 *
 * Obsidian has already split the query on every "&", which cuts a readable
 * passage that contains "&". Since `q` is always the last parameter, any
 * unknown parameter that follows it is rejoined to the passage.
 */
export function parseCitationParams(params: ObsidianProtocolData): CitationTarget {
	let q = params.q;
	if (q !== undefined) {
		let afterQ = false;
		for (const key of Object.keys(params)) {
			if (key === 'q') {
				afterQ = true;
			} else if (afterQ && key !== 'action' && !KNOWN_PARAMS.includes(key)) {
				const rest = params[key];
				q += rest === 'true' || rest === '' ? `&${key}` : `&${key}=${rest}`;
			}
		}
	}
	return toTarget((key) => (key === 'q' ? q : params[key]));
}
