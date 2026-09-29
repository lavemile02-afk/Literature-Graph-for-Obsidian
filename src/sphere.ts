/**
 * The idle animation's geometry: the flat graph wrapped around a sphere that
 * turns on itself, drawn in perspective. No 3D engine: each point is placed
 * on the sphere, turned, then projected back to the plane.
 *
 * The graph's center becomes the pole facing the viewer and its edge nears
 * the opposite pole. Each point keeps its direction from the center, and its
 * distance becomes a polar angle chosen so that the works cover the sphere
 * evenly: a work farther from the center than a share q of the works lands
 * where a share q of the sphere's area is nearer the front pole. (With plain
 * distances, the dense core of a literature graph would crowd one cap of the
 * sphere and leave the rest empty.)
 */

export interface Sphere {
	/** Center of the graph, in world units. */
	cx: number;
	cy: number;
	/** Radius of the sphere. */
	radius: number;
	/** Distances of the works from the center, sorted: their ranks place them on the sphere. */
	distances: Float64Array;
}

/** The farthest works go this far around the sphere (radians from the front pole). */
const MAX_POLAR = Math.PI * 0.92;
/** Tilt of the sphere's axis toward the viewer, so that it looks like a globe. */
const TILT = 0.35;
/** Distance of the eye, in sphere radii: the perspective's strength. */
const EYE = 3.5;
/** The sphere's radius, as a share of the distance of the farthest works (outliers ignored). */
const RADIUS_SHARE = 0.55;
/** Share of works ignored at the edge when sizing the sphere (far outliers). */
const OUTLIERS = 0.02;

/** The sphere around a set of points: centered on them, sized by their spread. */
export function fitSphere(points: { x: number; y: number }[]): Sphere {
	if (points.length === 0) return { cx: 0, cy: 0, radius: 1, distances: new Float64Array([0]) };
	const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
	const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
	const distances = Float64Array.from(points.map((p) => Math.hypot(p.x - cx, p.y - cy))).sort();
	const reach = distances[Math.min(distances.length - 1, Math.floor(distances.length * (1 - OUTLIERS)))] ?? 1;
	return { cx, cy, radius: Math.max(1, reach * RADIUS_SHARE), distances };
}

/** Share of the works nearer the center than `r` (0 to 1), interpolated between ranks. */
function shareWithin(sorted: Float64Array, r: number): number {
	const n = sorted.length;
	if (n <= 1) return r > 0 ? 1 : 0;
	let lo = 0;
	let hi = n - 1;
	if (r <= (sorted[0] ?? 0)) return 0;
	if (r >= (sorted[hi] ?? 0)) return 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if ((sorted[mid] ?? 0) <= r) lo = mid;
		else hi = mid;
	}
	const a = sorted[lo] ?? 0;
	const b = sorted[hi] ?? 0;
	return (lo + (b > a ? (r - a) / (b - a) : 0)) / (n - 1);
}

export interface Projected {
	x: number;
	y: number;
	/** Size factor from the perspective (1 at the sphere's center depth). */
	scale: number;
	/** 1 on the side facing the viewer, 0 at the back. */
	front: number;
}

/**
 * Where a point of the flat graph is seen when the graph is wrapped around the
 * sphere turned by `angle` (radians, around its axis).
 */
export function projectOnSphere(x: number, y: number, sphere: Sphere, angle: number): Projected {
	const R = sphere.radius;
	const dx = x - sphere.cx;
	const dy = y - sphere.cy;
	// A share q of the sphere's area lies within polar angle φ of the pole
	// when (1 - cos φ) / 2 = q; up to MAX_POLAR.
	const q = shareWithin(sphere.distances, Math.hypot(dx, dy));
	const polar = Math.acos(1 - q * (1 - Math.cos(MAX_POLAR)));
	const azimuth = Math.atan2(dy, dx);
	// On the sphere, the front pole toward the viewer (z > 0).
	const px = R * Math.sin(polar) * Math.cos(azimuth);
	const py0 = R * Math.sin(polar) * Math.sin(azimuth);
	const pz0 = R * Math.cos(polar);
	// The front pole leans down a little, then the globe turns around its (tilted) axis.
	const py = py0 * Math.cos(TILT) - pz0 * Math.sin(TILT);
	const pz1 = py0 * Math.sin(TILT) + pz0 * Math.cos(TILT);
	const tx = px * Math.cos(angle) + pz1 * Math.sin(angle);
	const tz = -px * Math.sin(angle) + pz1 * Math.cos(angle);
	const scale = EYE / (EYE - tz / R);
	return { x: sphere.cx + tx * scale, y: sphere.cy + py * scale, scale, front: (tz / R + 1) / 2 };
}

/**
 * The order in which the works appear one by one: the works of the vault
 * first (most cited first), then the works outside it, generation by
 * generation, oldest first (the literature building up). Returns each work's
 * rank, by index.
 */
export function appearanceOrder(works: { generation: number; year: number | null; citedBy: number }[]): number[] {
	const indices = works.map((_, i) => i);
	indices.sort((a, b) => {
		const wa = works[a];
		const wb = works[b];
		if (!wa || !wb) return 0;
		if (wa.generation !== wb.generation) return wa.generation - wb.generation;
		if (wa.generation === 0) return wb.citedBy - wa.citedBy;
		return (wa.year ?? Infinity) - (wb.year ?? Infinity) || wb.citedBy - wa.citedBy;
	});
	const rank = new Array<number>(works.length).fill(0);
	indices.forEach((index, position) => (rank[index] = position));
	return rank;
}
