import { App, requestUrl } from 'obsidian';
import { normalizeDoi } from './citationIndex';

/**
 * A small client for OpenAlex (https://openalex.org), a free and open index
 * of scholarly works, with a local cache so that bibliographies stay
 * available offline and each work is requested only once.
 */

const API = 'https://api.openalex.org';
/** OpenAlex allows 10 requests per second; stay below. */
const MIN_INTERVAL_MS = 110;
/** Ids or DOIs per request (OpenAlex accepts up to 50 values in a filter). */
const BATCH_SIZE = 50;
const SELECT = 'id,doi,display_name,publication_year,authorships,primary_location,referenced_works,cited_by_count';
const CACHE_VERSION = 1;

/** What the plugin keeps about a work. */
export interface WorkSummary {
	/** OpenAlex id, such as "W2741809807". */
	id: string;
	doi: string | null;
	title: string;
	year: number | null;
	/** Author names as OpenAlex displays them ("Benoît Bourgeois"). */
	authors: string[];
	venue: string | null;
	/** OpenAlex ids of the works it cites. */
	references: string[];
	citedByCount: number;
}

/**
 * The full record of one work, for its ghost note: what a literature note's
 * properties need. Fetched only when a work is opened (a lookup by id or DOI
 * is free on OpenAlex), then cached.
 */
export interface WorkDetails {
	id: string;
	doi: string | null;
	title: string;
	year: number | null;
	/** Author names as OpenAlex writes them ("Benoît Bourgeois"). */
	authors: string[];
	/** OpenAlex's type: "article", "book", "book-chapter", "dissertation", "report", "preprint"... */
	type: string | null;
	/** Journal or book series. */
	journal: string | null;
	volume: string | null;
	issue: string | null;
	firstPage: string | null;
	lastPage: string | null;
	publisher: string | null;
	issn: string | null;
	/** ISO 639-1 code ("en"). */
	language: string | null;
	/** A link to a free, legal PDF, when OpenAlex knows one. */
	pdfUrl: string | null;
	/** A page where the work can be read for free (when there is no direct PDF). */
	openAccessUrl: string | null;
	abstract: string | null;
}

interface CacheFile {
	version: number;
	works: Record<string, WorkSummary>;
	/** Full records of the works opened as ghost notes, by OpenAlex id. */
	details?: Record<string, WorkDetails>;
	/** DOI → OpenAlex id, or null when OpenAlex does not know the DOI. */
	doiToId: Record<string, string | null>;
	/** OpenAlex ids that OpenAlex did not return (merged or deleted works). */
	missingIds?: Record<string, true>;
	/** Work id → the most cited works that cite it, and how many cite it in all. */
	citedBy?: Record<string, { total: number; ids: string[] }>;
}

/** Works citing a work: the most cited ones first, with the total count. */
export interface CitingWorks {
	total: number;
	works: WorkSummary[];
}

interface RawWork {
	id?: string;
	doi?: string | null;
	display_name?: string | null;
	publication_year?: number | null;
	authorships?: { author?: { display_name?: string | null } }[];
	primary_location?: { source?: { display_name?: string | null } | null } | null;
	referenced_works?: string[];
	cited_by_count?: number;
}

const shortId = (id: string): string => id.replace(/^https:\/\/openalex\.org\//, '');

const DETAILS_SELECT =
	'id,doi,display_name,publication_year,authorships,type,biblio,primary_location,best_oa_location,open_access,language,abstract_inverted_index';

interface RawDetails {
	id?: string;
	doi?: string | null;
	display_name?: string | null;
	publication_year?: number | null;
	authorships?: { author?: { display_name?: string | null } }[];
	type?: string | null;
	biblio?: { volume?: string | null; issue?: string | null; first_page?: string | null; last_page?: string | null };
	primary_location?: {
		source?: { display_name?: string | null; host_organization_name?: string | null; issn_l?: string | null } | null;
	} | null;
	best_oa_location?: { pdf_url?: string | null; landing_page_url?: string | null } | null;
	open_access?: { oa_url?: string | null } | null;
	language?: string | null;
	abstract_inverted_index?: Record<string, number[]> | null;
}

/** An abstract from OpenAlex's inverted index (word → its positions). */
export function abstractFromIndex(index: Record<string, number[]> | null | undefined): string | null {
	if (!index) return null;
	const words: string[] = [];
	for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
	const text = words.filter((w) => w !== undefined).join(' ').trim();
	return text || null;
}

function details(raw: RawDetails): WorkDetails {
	const source = raw.primary_location?.source ?? null;
	const pdf = raw.best_oa_location?.pdf_url ?? null;
	return {
		id: shortId(raw.id ?? ''),
		doi: raw.doi ? normalizeDoi(raw.doi) : null,
		title: raw.display_name ?? '',
		year: raw.publication_year ?? null,
		authors: (raw.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean),
		type: raw.type ?? null,
		journal: source?.display_name ?? null,
		volume: raw.biblio?.volume ?? null,
		issue: raw.biblio?.issue ?? null,
		firstPage: raw.biblio?.first_page ?? null,
		lastPage: raw.biblio?.last_page ?? null,
		publisher: source?.host_organization_name ?? null,
		issn: source?.issn_l ?? null,
		language: raw.language ?? null,
		pdfUrl: pdf,
		openAccessUrl: pdf ? null : (raw.open_access?.oa_url ?? raw.best_oa_location?.landing_page_url ?? null),
		abstract: abstractFromIndex(raw.abstract_inverted_index),
	};
}

function summarize(raw: RawWork): WorkSummary {
	return {
		id: shortId(raw.id ?? ''),
		doi: raw.doi ? normalizeDoi(raw.doi) : null,
		title: raw.display_name ?? '',
		year: raw.publication_year ?? null,
		authors: (raw.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean),
		venue: raw.primary_location?.source?.display_name ?? null,
		references: (raw.referenced_works ?? []).map(shortId),
		citedByCount: raw.cited_by_count ?? 0,
	};
}

/** OpenAlex refuses requests for now: its free daily budget is used up, or it is overloaded. */
export class OpenAlexLimitError extends Error {
	constructor(readonly until: number) {
		super(
			`OpenAlex refuses requests until ${new Date(until).toLocaleTimeString()}. Without an API key, OpenAlex allows a small free daily budget per network; a free key (see the plugin settings) has its own budget.`,
		);
		this.name = 'OpenAlexLimitError';
	}
}

export class OpenAlexClient {
	private cache: CacheFile = { version: CACHE_VERSION, works: {}, doiToId: {} };
	private loaded = false;
	private lastRequest = 0;
	private queue: Promise<unknown> = Promise.resolve();
	private saveTimer: number | null = null;

	constructor(
		private readonly app: App,
		private readonly cachePath: string,
		private readonly options: () => { enabled: boolean; email: string; apiKey: string },
	) {}

	/** Reads the cache file, once. */
	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			if (await this.app.vault.adapter.exists(this.cachePath)) {
				const data = JSON.parse(await this.app.vault.adapter.read(this.cachePath)) as CacheFile;
				if (data.version === CACHE_VERSION) this.cache = data;
			}
		} catch (error) {
			console.error('Literature Graph: could not read the OpenAlex cache', error);
		}
	}

	/** Writes the cache file a little after the last change. */
	private scheduleSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.app.vault.adapter.write(this.cachePath, JSON.stringify(this.cache));
		}, 2000);
	}

	/** Writes pending cache changes now (on unload). */
	async flush(): Promise<void> {
		if (this.saveTimer === null) return;
		window.clearTimeout(this.saveTimer);
		this.saveTimer = null;
		await this.app.vault.adapter.write(this.cachePath, JSON.stringify(this.cache));
	}

	/** Empties the cache. */
	async clear(): Promise<void> {
		this.cache = { version: CACHE_VERSION, works: {}, doiToId: {} };
		await this.app.vault.adapter.write(this.cachePath, JSON.stringify(this.cache));
	}

	/**
	 * Until when OpenAlex refuses requests (429). Without an API key, OpenAlex
	 * gives a small free daily budget per network, renewed at midnight UTC;
	 * once it is used up, the plugin stops asking until then, instead of
	 * sending requests that are sure to be refused.
	 */
	private limitedUntil = 0;

	/** Called once each time OpenAlex starts refusing requests. */
	onLimit: ((error: OpenAlexLimitError) => void) | null = null;
	/** The last failure of a request, if the last attempt failed. */
	lastError: Error | null = null;

	/**
	 * Runs a fetch; when it fails, keeps what was cached and remembers the
	 * error, so that callers show cached data rather than nothing.
	 */
	private async tryFetch(fetch: () => Promise<unknown>): Promise<void> {
		try {
			await fetch();
			this.lastError = null;
		} catch (error) {
			this.lastError = error instanceof Error ? error : new Error(String(error));
			if (!(error instanceof OpenAlexLimitError)) console.error('Literature Graph: OpenAlex request failed', error);
		}
	}

	/** Whether OpenAlex is refusing requests for now (daily budget or overload). */
	get isRateLimited(): boolean {
		return Date.now() < this.limitedUntil;
	}

	/** GET a path of the API, one request at a time, below the rate limit. */
	private request(path: string, params: Record<string, string>): Promise<unknown> {
		const { email, apiKey } = this.options();
		const query = new URLSearchParams(params);
		if (email.trim()) query.set('mailto', email.trim());
		const run = async () => {
			if (this.isRateLimited) throw new OpenAlexLimitError(this.limitedUntil);
			const wait = this.lastRequest + MIN_INTERVAL_MS - Date.now();
			if (wait > 0) await sleep(wait);
			this.lastRequest = Date.now();
			const response = await requestUrl({
				url: `${API}${path}?${query.toString()}`,
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
				throw: false,
			});
			if (response.status === 404) return null;
			if (response.status === 429) {
				const text = response.text.toLowerCase();
				// A used-up daily budget comes back at midnight UTC; an overload soon.
				const midnight = new Date();
				midnight.setUTCHours(24, 0, 0, 0);
				this.limitedUntil = text.includes('budget') ? midnight.getTime() : Date.now() + 60_000;
				const error = new OpenAlexLimitError(this.limitedUntil);
				this.onLimit?.(error);
				throw error;
			}
			if (response.status >= 400) throw new Error(`OpenAlex answered ${response.status}`);
			return response.json as unknown;
		};
		const result = this.queue.then(run, run);
		this.queue = result.catch(() => undefined);
		return result;
	}

	/** Fetches works by a filter on one field, in batches, and caches them. */
	private async fetchBy(
		field: 'doi' | 'openalex_id',
		values: string[],
		onProgress?: (done: number, total: number) => void,
	): Promise<WorkSummary[]> {
		const found: WorkSummary[] = [];
		for (let i = 0; i < values.length; i += BATCH_SIZE) {
			onProgress?.(i, values.length);
			const batch = values.slice(i, i + BATCH_SIZE);
			const data = (await this.request('/works', {
				filter: `${field}:${batch.join('|')}`,
				'per-page': String(BATCH_SIZE),
				select: SELECT,
			})) as { results?: RawWork[] } | null;
			for (const raw of data?.results ?? []) {
				const work = summarize(raw);
				this.cache.works[work.id] = work;
				if (work.doi) this.cache.doiToId[work.doi] = work.id;
				found.push(work);
			}
			// Remember what OpenAlex does not know, so as not to ask again.
			if (field === 'doi') {
				for (const doi of batch) if (!(doi in this.cache.doiToId)) this.cache.doiToId[doi] = null;
			} else {
				const missing = (this.cache.missingIds ??= {});
				for (const id of batch) if (!this.cache.works[id]) missing[id] = true;
			}
			this.scheduleSave();
		}
		onProgress?.(values.length, values.length);
		return found;
	}

	/**
	 * Whether OpenAlex no longer has this work (merged or deleted), although
	 * other works still list it among their references.
	 */
	isMissing(id: string): boolean {
		return this.cache.missingIds?.[id] === true;
	}

	/** A cached work, without any request. */
	cachedWork(id: string): WorkSummary | null {
		return this.cache.works[id] ?? null;
	}

	/** The OpenAlex id of a DOI if it is cached, without any request. */
	cachedIdForDoi(doi: string): string | null {
		return this.cache.doiToId[normalizeDoi(doi)] ?? null;
	}

	/** The work with this DOI, from the cache or OpenAlex; null if unknown or offline. */
	async workByDoi(doi: string): Promise<WorkSummary | null> {
		const [work] = await this.worksByDois([doi]);
		return work ?? null;
	}

	/** Works by DOI, in the same order; unknown DOIs are left out. */
	async worksByDois(dois: string[], onProgress?: (done: number, total: number) => void): Promise<WorkSummary[]> {
		await this.load();
		const wanted = dois.map(normalizeDoi);
		const missing = [...new Set(wanted.filter((d) => !(d in this.cache.doiToId)))];
		if (missing.length > 0 && this.options().enabled) await this.tryFetch(() => this.fetchBy('doi', missing, onProgress));
		return wanted
			.map((d) => this.cache.doiToId[d])
			.map((id) => (id ? this.cache.works[id] : undefined))
			.filter((w): w is WorkSummary => w !== undefined);
	}

	/** Works by OpenAlex id; works not cached are fetched when possible. */
	async worksByIds(ids: string[], onProgress?: (done: number, total: number) => void): Promise<WorkSummary[]> {
		await this.load();
		const known = this.cache.missingIds ?? {};
		const missing = ids.filter((id) => !this.cache.works[id] && !known[id]);
		if (missing.length > 0 && this.options().enabled) await this.tryFetch(() => this.fetchBy('openalex_id', missing, onProgress));
		return ids.map((id) => this.cache.works[id]).filter((w): w is WorkSummary => w !== undefined);
	}

	/**
	 * The works that cite a work, most cited first (at most `limit`), and how
	 * many cite it in all. Cached; null when not cached and OpenAlex is off.
	 */
	async citingWorks(id: string, limit = 50): Promise<CitingWorks | null> {
		await this.load();
		const citedBy = (this.cache.citedBy ??= {});
		let entry = citedBy[id];
		if (!entry) {
			if (!this.options().enabled || this.isRateLimited) return null;
			const data = (await this.request('/works', {
				filter: `cites:${id}`,
				sort: 'cited_by_count:desc',
				'per-page': String(Math.min(limit, 200)),
				select: SELECT,
			})) as { meta?: { count?: number }; results?: RawWork[] } | null;
			const works = (data?.results ?? []).map(summarize);
			for (const work of works) {
				this.cache.works[work.id] = work;
				if (work.doi) this.cache.doiToId[work.doi] = work.id;
			}
			entry = { total: data?.meta?.count ?? works.length, ids: works.map((w) => w.id) };
			citedBy[id] = entry;
			this.scheduleSave();
		}
		return {
			total: entry.total,
			works: entry.ids.map((i) => this.cache.works[i]).filter((w): w is WorkSummary => w !== undefined),
		};
	}

	/**
	 * The full record of a work (by OpenAlex id, or by DOI), from the cache or
	 * OpenAlex (a free lookup); null when unknown, or offline and not cached.
	 */
	async workDetails(ref: { id?: string | null; doi?: string | null }): Promise<WorkDetails | null> {
		await this.load();
		const all = (this.cache.details ??= {});
		const id = ref.id ?? (ref.doi ? this.cachedIdForDoi(ref.doi) : null);
		if (id && all[id]) return all[id] ?? null;
		if (!this.options().enabled || this.isRateLimited) return null;
		const path = id ? `/works/${id}` : ref.doi ? `/works/doi:${normalizeDoi(ref.doi)}` : null;
		if (!path) return null;
		let found: WorkDetails | null = null;
		await this.tryFetch(async () => {
			const raw = (await this.request(path, { select: DETAILS_SELECT })) as RawDetails | null;
			if (!raw?.id) return;
			found = details(raw);
			all[found.id] = found;
			if (found.doi) this.cache.doiToId[found.doi] = found.id;
			this.scheduleSave();
		});
		return found;
	}

	/** Whether a DOI was already looked up (found or not). */
	isKnownDoi(doi: string): boolean {
		return normalizeDoi(doi) in this.cache.doiToId;
	}
}

/** Words that belong to a surname when they come before it: "Van den Brink", "De Cáceres", "ter Braak". */
const PARTICLES = new Set([
	'van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'du', 'des', 'dos', 'das', 'le', 'la', 'ter', 'ten', 'st.', 'saint', 'al', 'el', 'bin', 'ibn',
]);

/** The surname in a full name as OpenAlex writes it ("Paul J. Van den Brink" → "Van den Brink"). */
export function surnameOf(fullName: string): string {
	const tokens = fullName.trim().split(/\s+/).filter(Boolean);
	let start = tokens.length - 1;
	while (start > 1 && PARTICLES.has((tokens[start - 1] ?? '').toLowerCase())) start--;
	return tokens.slice(Math.max(0, start)).join(' ') || fullName;
}

/** "Bourgeois et al., 2016" from OpenAlex author names and year. */
export function workCitation(work: WorkSummary, language: 'en' | 'fr'): string {
	const names = work.authors.map(surnameOf);
	const year = work.year ?? (language === 'fr' ? 's.d.' : 'n.d.');
	if (names.length === 0) return `${work.title.slice(0, 40)}, ${year}`;
	if (names.length === 1) return `${names[0]}, ${year}`;
	if (names.length === 2) return `${names[0]} ${language === 'fr' ? 'et' : '&'} ${names[1]}, ${year}`;
	return `${names[0]} et al., ${year}`;
}
