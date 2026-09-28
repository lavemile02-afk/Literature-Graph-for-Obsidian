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

interface CacheFile {
	version: number;
	works: Record<string, WorkSummary>;
	/** DOI → OpenAlex id, or null when OpenAlex does not know the DOI. */
	doiToId: Record<string, string | null>;
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

export class OpenAlexClient {
	private cache: CacheFile = { version: CACHE_VERSION, works: {}, doiToId: {} };
	private loaded = false;
	private lastRequest = 0;
	private queue: Promise<unknown> = Promise.resolve();
	private saveTimer: number | null = null;

	constructor(
		private readonly app: App,
		private readonly cachePath: string,
		private readonly options: () => { enabled: boolean; email: string },
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
			console.error('Literature Graph.md: could not read the OpenAlex cache', error);
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

	/** GET a path of the API, one request at a time, below the rate limit. */
	private request(path: string, params: Record<string, string>): Promise<unknown> {
		const { email } = this.options();
		const query = new URLSearchParams(params);
		if (email.trim()) query.set('mailto', email.trim());
		const run = async () => {
			const wait = this.lastRequest + MIN_INTERVAL_MS - Date.now();
			if (wait > 0) await sleep(wait);
			this.lastRequest = Date.now();
			const response = await requestUrl({ url: `${API}${path}?${query.toString()}`, throw: false });
			if (response.status === 404) return null;
			if (response.status >= 400) throw new Error(`OpenAlex answered ${response.status}`);
			return response.json as unknown;
		};
		const result = this.queue.then(run, run);
		this.queue = result.catch(() => undefined);
		return result;
	}

	/** Fetches works by a filter on one field, in batches, and caches them. */
	private async fetchBy(field: 'doi' | 'openalex_id', values: string[]): Promise<WorkSummary[]> {
		const found: WorkSummary[] = [];
		for (let i = 0; i < values.length; i += BATCH_SIZE) {
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
			if (field === 'doi') {
				// Remember the DOIs OpenAlex does not know, so as not to ask again.
				for (const doi of batch) if (!(doi in this.cache.doiToId)) this.cache.doiToId[doi] = null;
			}
			this.scheduleSave();
		}
		return found;
	}

	/** The work with this DOI, from the cache or OpenAlex; null if unknown or offline. */
	async workByDoi(doi: string): Promise<WorkSummary | null> {
		const [work] = await this.worksByDois([doi]);
		return work ?? null;
	}

	/** Works by DOI, in the same order; unknown DOIs are left out. */
	async worksByDois(dois: string[]): Promise<WorkSummary[]> {
		await this.load();
		const wanted = dois.map(normalizeDoi);
		const missing = wanted.filter((d) => !(d in this.cache.doiToId));
		if (missing.length > 0 && this.options().enabled) await this.fetchBy('doi', missing);
		return wanted
			.map((d) => this.cache.doiToId[d])
			.map((id) => (id ? this.cache.works[id] : undefined))
			.filter((w): w is WorkSummary => w !== undefined);
	}

	/** Works by OpenAlex id; works not cached are fetched when possible. */
	async worksByIds(ids: string[]): Promise<WorkSummary[]> {
		await this.load();
		const missing = ids.filter((id) => !this.cache.works[id]);
		if (missing.length > 0 && this.options().enabled) await this.fetchBy('openalex_id', missing);
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
			if (!this.options().enabled) return null;
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

	/** Whether a DOI was already looked up (found or not). */
	isKnownDoi(doi: string): boolean {
		return normalizeDoi(doi) in this.cache.doiToId;
	}
}

/** "Bourgeois et al., 2016" from OpenAlex author names and year. */
export function workCitation(work: WorkSummary, language: 'en' | 'fr'): string {
	const family = (name: string) => name.trim().split(/\s+/).pop() ?? name;
	const names = work.authors.map(family);
	const year = work.year ?? (language === 'fr' ? 's.d.' : 'n.d.');
	if (names.length === 0) return `${work.title.slice(0, 40)}, ${year}`;
	if (names.length === 1) return `${names[0]}, ${year}`;
	if (names.length === 2) return `${names[0]} ${language === 'fr' ? 'et' : '&'} ${names[1]}, ${year}`;
	return `${names[0]} et al., ${year}`;
}
