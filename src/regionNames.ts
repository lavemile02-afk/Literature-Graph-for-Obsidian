/**
 * Names of the regions of meaning (groups of works of one meaning, see
 * `meaningGroups` in `meaning.ts`), by three methods together:
 *
 * - **A, the meaning of the region**: the mean of the vectors of its works
 *   (its center of meaning), and the keyword whose own meaning (the mean of
 *   the works having it) is nearest to it, and further from the other
 *   regions: what the region is about, as a whole;
 * - **B, OpenAlex's topic**: the topic (named by people at OpenAlex) of at
 *   least 30 % of the region's works, the most over-represented in it;
 * - **C, its typical terms**: two or three keywords or words of titles,
 *   frequent in the region and rare elsewhere (class-based TF-IDF, as
 *   BERTopic names its topics).
 *
 * A gives the name, or B when A finds none; B (when not the name) and C come
 * below it. No Obsidian or Pixi here.
 */

/** What is known of a work for the names. */
export interface NamedWork {
	/** Its vector of meaning (length 1), if known. */
	vector: Float32Array | null;
	/** Its keywords (from its note or OpenAlex). */
	keywords: string[];
	/** The names of its OpenAlex topics, the main one first. */
	topics: string[];
	/** Words and pairs of words of its title (see `titleTerms`). */
	titleTerms: string[];
}

export interface RegionName {
	/** The name, or "" when nothing names the region. */
	title: string;
	/** OpenAlex's topic of the region, when it is not the name already. */
	topic: string | null;
	/** Its typical terms (at most three), not already in the name. */
	terms: string[];
}

/** A region's topic covers at least this share of its works. */
const TOPIC_COVERAGE = 0.3;
/** And is this many times more frequent in it than in the whole graph. */
const TOPIC_LIFT = 1.2;
/** A keyword names a region's meaning only if at least this many works of the graph have it… */
const MIN_KEYWORD_WORKS = 3;
/** …and this share of the region's works (at least 2): a keyword of a few works is too narrow for a whole region. */
const MIN_KEYWORD_COVERAGE = 0.08;

const key = (term: string) => term.trim().toLowerCase();
const display = (term: string) => {
	const t = term.trim();
	return t.charAt(0).toUpperCase() + t.slice(1);
};

function meanVector(vectors: Float32Array[]): Float32Array | null {
	const d = vectors[0]?.length ?? 0;
	if (d === 0) return null;
	const sum = new Float32Array(d);
	for (const v of vectors) for (let i = 0; i < d; i++) sum[i] = (sum[i] ?? 0) + (v[i] ?? 0);
	let n = 0;
	for (let i = 0; i < d; i++) n += (sum[i] ?? 0) ** 2;
	if (n === 0) return null;
	n = Math.sqrt(n);
	for (let i = 0; i < d; i++) sum[i] = (sum[i] ?? 0) / n;
	return sum;
}

function dot(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
	return s;
}

/** The names of the `count` regions; `group` gives each work's region (-1: none). */
export function regionNames(works: NamedWork[], group: number[], count: number): RegionName[] {
	const members: number[][] = Array.from({ length: count }, () => []);
	works.forEach((_, i) => {
		const g = group[i] ?? -1;
		if (g >= 0 && g < count) members[g]?.push(i);
	});

	// A: centers of meaning, and the meaning of each keyword.
	const vectorsOf = (list: number[]) =>
		list.flatMap((i) => {
			const v = works[i]?.vector;
			return v ? [v] : [];
		});
	const centers = members.map((list) => meanVector(vectorsOf(list)));
	const withKeyword = new Map<string, number[]>();
	const shown = new Map<string, string>();
	works.forEach((w, i) => {
		for (const k of new Set(w.keywords.map(key).filter(Boolean))) withKeyword.set(k, [...(withKeyword.get(k) ?? []), i]);
		for (const k of w.keywords) if (!shown.has(key(k))) shown.set(key(k), k);
	});
	const keywordMeaning = new Map<string, Float32Array>();
	for (const [k, list] of withKeyword) {
		if (list.length < MIN_KEYWORD_WORKS) continue;
		const v = meanVector(vectorsOf(list));
		if (v) keywordMeaning.set(k, v);
	}
	const candidatesA: { g: number; k: string; score: number }[] = [];
	members.forEach((list, g) => {
		const center = centers[g];
		if (!center) return;
		const inRegion = new Map<string, number>();
		for (const i of list) for (const k of new Set((works[i]?.keywords ?? []).map(key))) inRegion.set(k, (inRegion.get(k) ?? 0) + 1);
		for (const [k, v] of keywordMeaning) {
			const here = inRegion.get(k) ?? 0;
			const coverage = here / (list.length || 1);
			if (here < 2 || coverage < MIN_KEYWORD_COVERAGE) continue;
			const own = dot(center, v);
			let other = -1;
			centers.forEach((c, h) => {
				if (h !== g && c) other = Math.max(other, dot(c, v));
			});
			// Near this region's meaning, nearer to it than to any other region's, and shared by many of its works.
			candidatesA.push({ g, k, score: (own + 0.5 * (own - other)) * Math.sqrt(coverage) });
		}
	});
	candidatesA.sort((a, b) => b.score - a.score || (a.k < b.k ? -1 : 1));
	const titles: string[] = Array.from({ length: count }, () => '');
	const used = new Set<string>();
	for (const { g, k } of candidatesA) {
		if (titles[g] || used.has(k)) continue;
		titles[g] = display(shown.get(k) ?? k);
		used.add(k);
	}

	// B: the over-represented topic covering enough of the region.
	const total = works.length || 1;
	const topicCount = new Map<string, number>();
	for (const w of works) for (const t of new Set(w.topics)) topicCount.set(t, (topicCount.get(t) ?? 0) + 1);
	const topics = members.map((list) => {
		const here = new Map<string, number>();
		for (const i of list) for (const t of new Set(works[i]?.topics ?? [])) here.set(t, (here.get(t) ?? 0) + 1);
		let best: { t: string; score: number } | null = null;
		for (const [t, c] of here) {
			const coverage = c / (list.length || 1);
			const lift = coverage / ((topicCount.get(t) ?? c) / total);
			if (coverage < TOPIC_COVERAGE || lift < TOPIC_LIFT) continue;
			const score = coverage * Math.log(1 + lift);
			if (!best || score > best.score) best = { t, score };
		}
		return best?.t ?? null;
	});

	// C: class-based TF-IDF of the terms (keywords and words of titles).
	const termsOf = (i: number) => [...(works[i]?.keywords ?? []), ...(works[i]?.titleTerms ?? [])].map(key).filter((t) => t.length > 2);
	const perRegion = members.map((list) => {
		const counts = new Map<string, number>();
		for (const i of list) for (const t of new Set(termsOf(i))) counts.set(t, (counts.get(t) ?? 0) + 1);
		return counts;
	});
	const everywhere = new Map<string, number>();
	for (const counts of perRegion) for (const [t, c] of counts) everywhere.set(t, (everywhere.get(t) ?? 0) + c);
	const meanSize = perRegion.reduce((s, c) => s + [...c.values()].reduce((a, b) => a + b, 0), 0) / (count || 1);
	const termNames = new Map<string, string>();
	works.forEach((w) => {
		for (const t of [...w.keywords, ...w.titleTerms]) if (!termNames.has(key(t))) termNames.set(key(t), t);
	});

	return members.map((list, g): RegionName => {
		const topic = topics[g] ?? null;
		const title = titles[g] || (topic ?? '');
		const counts = perRegion[g] ?? new Map<string, number>();
		const size = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
		const scored = [...counts]
			.filter(([, c]) => c >= Math.max(2, list.length * 0.05))
			.map(([t, c]) => ({ t, score: (c / size) * Math.log(1 + meanSize / (everywhere.get(t) ?? c)) * (t.includes(' ') ? 1.5 : 1) }))
			.sort((a, b) => b.score - a.score || (a.t < b.t ? -1 : 1));
		const taken = [key(title), ...(topic ? [key(topic)] : [])];
		const terms: string[] = [];
		for (const { t } of scored) {
			if (terms.length >= 3) break;
			// Not a repetition of the name, of the topic or of a term already kept.
			if (taken.some((x) => x.includes(t) || t.includes(x)) || terms.some((x) => key(x).includes(t) || t.includes(key(x)))) continue;
			terms.push(display(termNames.get(t) ?? t));
		}
		return { title, topic: topic && topic !== title ? topic : null, terms };
	});
}
