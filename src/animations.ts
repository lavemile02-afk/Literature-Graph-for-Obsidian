/**
 * The idle animations: where each work of the graph is drawn at a given
 * moment, when Obsidian is left alone. No Obsidian, Pixi or d3 here: plain
 * geometry, drawn in perspective without a 3D engine (each work is placed in
 * space, turned, then projected back onto the plane).
 *
 * Several animations are adapted from the dotted orbs of thinking-orbs by
 * Jakub Antalik (MIT, https://github.com/Jakubantalik/thinking-orbs): the
 * scanning globe, the orbits, the wave, the twisting bands, the braid, the
 * ribbon and the constellation. There, a few hundred dots draw each shape;
 * here, the dots are the works of the graph.
 */

import { projectOnSphere, Sphere, sphereDirection } from './sphere';

export type IdleAnimation =
	| 'sphere'
	| 'drift'
	| 'globe'
	| 'orbits'
	| 'wave'
	| 'bands'
	| 'braid'
	| 'ribbon'
	| 'constellation';

/** The animations offered, in the order of the menus. */
export const IDLE_ANIMATIONS: Record<IdleAnimation, string> = {
	sphere: 'Rotating sphere',
	drift: 'Free drift',
	globe: 'Scanning globe',
	orbits: 'Orbits',
	wave: 'Wave',
	bands: 'Twisting bands',
	braid: 'Braid',
	ribbon: 'Ribbon',
	constellation: 'Constellation',
};

/** The choices of the menus: an animation, or a random one each time. */
export type IdleChoice = IdleAnimation | 'random';
export const IDLE_CHOICES: Record<IdleChoice, string> = { random: 'Random animation', ...IDLE_ANIMATIONS };

/** An animation picked at random, other than the one just played (if there is a choice). */
export function randomAnimation(previous: IdleAnimation | null, random: () => number = Math.random): IdleAnimation {
	const all = Object.keys(IDLE_ANIMATIONS) as IdleAnimation[];
	const others = all.filter((a) => a !== previous);
	const pool = others.length > 0 ? others : all;
	return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] ?? 'sphere';
}

export function isIdleChoice(value: unknown): value is IdleChoice {
	return value === 'random' || isIdleAnimation(value);
}

export function isIdleAnimation(value: unknown): value is IdleAnimation {
	return typeof value === 'string' && value in IDLE_ANIMATIONS;
}

/**
 * Whether the citation lines stay drawn during an animation. In the others,
 * they fade out and every work moves freely; a click brings them back.
 */
export function keepsEdges(animation: IdleAnimation): boolean {
	return animation === 'sphere' || animation === 'constellation';
}

/** Whether bright signals run along the citation lines (the constellation). */
export function hasSignals(animation: IdleAnimation): boolean {
	return animation === 'constellation';
}

/** Whether the camera frames the shape (all but the free drift, which stays where the graph is). */
export function framesShape(animation: IdleAnimation): boolean {
	return animation !== 'drift';
}

/** Where a work is drawn: position (world units), size factor and depth (1: in front, 0: at the back). */
export interface Placed {
	x: number;
	y: number;
	scale: number;
	front: number;
}

/** What an animation needs about the works, computed once when it starts. */
export interface AnimationSetup {
	sphere: Sphere;
	/** A point of an even dotted sphere for each work (x, y, z by index; y up), near its place in the graph. */
	lattice: Float64Array;
	/** Orbit or strand of each work, and its place along it (0 to 1). */
	group: Int32Array;
	along: Float64Array;
	/** Size of each orbit (radius share) and its plane. */
	orbits: { radius: number; u: Vec; v: Vec; speed: number }[];
}

type Vec = [number, number, number];

/** Distance of the eye, in sphere radii: the perspective's strength (as in `sphere.ts`). */
const EYE = 3.5;
/** Number of orbits of the "orbits" animation. */
const ORBITS = 14;

/** Deterministic hash in [0, 1). */
export function hash(a: number, b: number): number {
	const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
	return h - Math.floor(h);
}

/** Smooth value noise on a 2D lattice, in [0, 1]. */
export function noise(x: number, y: number): number {
	const xi = Math.floor(x);
	const yi = Math.floor(y);
	let fx = x - xi;
	let fy = y - yi;
	fx = fx * fx * (3 - 2 * fx);
	fy = fy * fy * (3 - 2 * fy);
	const a = hash(xi, yi);
	const b = hash(xi + 1, yi);
	const c = hash(xi, yi + 1);
	const d = hash(xi + 1, yi + 1);
	return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function frac(x: number): number {
	return x - Math.floor(x);
}

/** Shortest signed angle from b to a, in (-π, π]. */
function angleDelta(a: number, b: number): number {
	return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/** Point i of n spread evenly on the unit sphere (Fibonacci lattice), from the top pole down. */
export function fibonacci(i: number, n: number): Vec {
	const golden = Math.PI * (3 - Math.sqrt(5));
	const y = 1 - (2 * (i + 0.5)) / n;
	const r = Math.sqrt(Math.max(0, 1 - y * y));
	const a = i * golden;
	return [r * Math.cos(a), y, r * Math.sin(a)];
}

/**
 * Prepares the animations for the works at these positions: each work gets a
 * point of an even dotted sphere (the works at the graph's center near the
 * top pole, those at its edge near the bottom one), an orbit and a strand.
 * `groupOf` puts works together (on one orbit): the index of the work of the
 * vault that cites a work, for example.
 */
export function setUpAnimation(points: { x: number; y: number }[], sphere: Sphere, groupOf: (i: number) => number): AnimationSetup {
	const n = points.length;
	// Height of each work on the sphere of `sphere.ts` (its center as the top
	// pole): the lattice's points are handed out from top to bottom in that order.
	const heights = points.map((p) => sphereDirection(p.x, p.y, sphere)[2]);
	const byHeight = points.map((_, i) => i).sort((a, b) => (heights[b] ?? 0) - (heights[a] ?? 0));
	const lattice = new Float64Array(n * 3);
	byHeight.forEach((work, i) => {
		const [x, y, z] = fibonacci(i, n);
		lattice[work * 3] = x;
		lattice[work * 3 + 1] = y;
		lattice[work * 3 + 2] = z;
	});
	const orbits = Array.from({ length: ORBITS }, (_, o) => {
		const h1 = hash(o, 1.7);
		const h2 = hash(o, 5.2);
		const h3 = hash(o, 8.9);
		// A tilted plane: its normal, then two axes in it.
		const theta = h1 * 2 * Math.PI;
		const phi = Math.acos(2 * h2 - 1);
		const nx = Math.sin(phi) * Math.cos(theta);
		const ny = Math.cos(phi);
		const nz = Math.sin(phi) * Math.sin(theta);
		const length = Math.max(1e-6, Math.hypot(ny, nx));
		const u: Vec = [-ny / length, nx / length, 0];
		const v: Vec = [ny * u[2] - nz * u[1], nz * u[0] - nx * u[2], nx * u[1] - ny * u[0]];
		return { radius: 0.45 + 0.52 * h1, u, v, speed: (0.25 + 0.55 * h3) * (h3 > 0.5 ? 1 : -1) };
	});
	// Works of one group share an orbit; along it, they are spread evenly.
	const group = new Int32Array(n);
	const members = new Map<number, number[]>();
	for (let i = 0; i < n; i++) {
		const o = Math.floor(hash(groupOf(i), 3.3) * ORBITS) % ORBITS;
		group[i] = o;
		const list = members.get(o) ?? [];
		list.push(i);
		members.set(o, list);
	}
	const along = new Float64Array(n);
	for (const list of members.values()) list.forEach((i, k) => (along[i] = k / list.length));
	return { sphere, lattice, group, along, orbits };
}

/** Projects a point (sphere radii, y up) turned by `yaw` and tilted by `tilt`, in perspective. */
function view(x: number, y: number, z: number, yaw: number, tilt: number, sphere: Sphere): Placed {
	const cy = Math.cos(yaw);
	const sy = Math.sin(yaw);
	const x1 = x * cy + z * sy;
	const z1 = -x * sy + z * cy;
	const y1 = y * Math.cos(tilt) - z1 * Math.sin(tilt);
	const z2 = y * Math.sin(tilt) + z1 * Math.cos(tilt);
	const scale = EYE / (EYE - z2);
	const R = sphere.radius;
	return { x: sphere.cx + x1 * R * scale, y: sphere.cy - y1 * R * scale, scale, front: Math.min(1, Math.max(0, (z2 + 1) / 2)) };
}

/**
 * Where work `i` (at `x`, `y` in the flat graph) is drawn by an animation,
 * `t` seconds after it started (already multiplied by the speed setting).
 */
export function placeWork(animation: IdleAnimation, setup: AnimationSetup, i: number, x: number, y: number, t: number): Placed {
	const sphere = setup.sphere;
	const lx = setup.lattice[i * 3] ?? 0;
	const ly = setup.lattice[i * 3 + 1] ?? 0;
	const lz = setup.lattice[i * 3 + 2] ?? 0;
	switch (animation) {
		case 'drift': {
			// Every work floats on its own, slowly, around its place in the graph.
			const reach = sphere.radius * 0.35;
			const dx = (noise(i * 0.37 + 11, t * 0.12) - 0.5) * 2 * reach;
			const dy = (noise(i * 0.53 + 47, t * 0.1) - 0.5) * 2 * reach;
			const pulse = 0.5 + 0.5 * Math.sin(t * 0.7 + i * 2.7);
			return { x: x + dx, y: y + dy, scale: 1 + 0.15 * pulse, front: 0.7 + 0.3 * pulse };
		}
		case 'globe': {
			// An even dotted globe; a meridian sweeps it and swells the works it passes.
			const spin = t * 0.25;
			const p = view(lx, ly, lz, spin, 0.4 + 0.06 * Math.sin(t * 0.35), sphere);
			const d = angleDelta(Math.atan2(lz, lx) + spin, t * 0.85);
			const boost = Math.exp(-(d * d) / 0.18) * Math.max(0, p.front * 2 - 1);
			return { ...p, scale: p.scale * (1 + 1.2 * boost), front: Math.min(1, p.front * 0.8 + boost) };
		}
		case 'orbits': {
			// Works turning on tilted orbits, those cited by one work of the vault on the same one.
			const orbit = setup.orbits[setup.group[i] ?? 0];
			if (!orbit) return view(lx, ly, lz, t * 0.12, 0.3, sphere);
			const a = t * orbit.speed * 0.5 + (setup.along[i] ?? 0) * 2 * Math.PI;
			const r = orbit.radius;
			const [u, v] = [orbit.u, orbit.v];
			return view(
				(u[0] * Math.cos(a) + v[0] * Math.sin(a)) * r,
				(u[1] * Math.cos(a) + v[1] * Math.sin(a)) * r,
				(u[2] * Math.cos(a) + v[2] * Math.sin(a)) * r,
				t * 0.12,
				0.3,
				sphere,
			);
		}
		case 'wave': {
			// A waveform rolls through the rings of the globe, from pole to pole.
			const ring = ((ly + 1) / 2) * 15;
			const w = 0.62 * Math.sin(t * 2.1 - ring * 0.52) + 0.38 * Math.sin(t * 1.27 + ring * 0.83);
			const r = 0.88 + 0.105 * w;
			const p = view(lx * r, ly * r, lz * r, t * 0.18, 0.38, sphere);
			return { ...p, scale: p.scale * (1 + 0.4 * Math.max(0, w)) };
		}
		case 'bands': {
			// Bands of the globe twist in quarter turns, scramble, then solve again.
			const [bx, by, bz, active] = twist(lx, ly, lz, t);
			const p = view(bx, by, bz, t * 0.55, 0.35 + 0.1 * Math.sin(t * 0.9), sphere);
			return active ? { ...p, scale: p.scale * 1.3 } : p;
		}
		case 'braid': {
			// Three strands plaiting around the sphere, pole to pole.
			const strand = i % 3;
			const phase = (strand / 3) * 2 * Math.PI;
			const u = (frac((setup.lattice.length ? i / (setup.lattice.length / 3) : 0) + t * 0.045) * 2 - 1) * 0.96;
			const surface = Math.sqrt(Math.max(0, 1 - u * u));
			const a = u * Math.PI * 3 + phase;
			const weave = 1 + 0.075 * Math.sin(u * Math.PI * 6 + phase * 2 + t * 0.8);
			const p = view(Math.cos(a) * surface * weave, u * weave, Math.sin(a) * surface * weave, t * 0.4, 0.3, sphere);
			const ends = Math.min(1, (1 - Math.abs(u)) / 0.1);
			return { ...p, front: p.front * ends };
		}
		case 'ribbon': {
			// An undulating sash of parallel lanes around a great circle.
			const n = setup.lattice.length / 3;
			const lanes = 5;
			const lane = i % lanes;
			const k = Math.floor(i / lanes);
			const segments = Math.max(1, Math.ceil(n / lanes));
			const a = (k / segments) * 2 * Math.PI;
			const yaw = t * 0.24;
			const tilt = 0.55 + 0.3 * Math.sin(t * 0.18);
			const u: Vec = [Math.cos(yaw), 0, Math.sin(yaw)];
			const v: Vec = [-u[2] * Math.sin(tilt), Math.cos(tilt), u[0] * Math.sin(tilt)];
			const normal: Vec = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
			const wobble = 0.16 * Math.sin(a * 3 - t * 1.7 + lane * 0.22) + 0.07 * Math.sin(a * 5 + t * 1.1);
			const offset = (lane - (lanes - 1) / 2) * 0.075 + wobble;
			const px = u[0] * Math.cos(a) + v[0] * Math.sin(a) + normal[0] * offset;
			const py = u[1] * Math.cos(a) + v[1] * Math.sin(a) + normal[1] * offset;
			const pz = u[2] * Math.cos(a) + v[2] * Math.sin(a) + normal[2] * offset;
			const length = Math.hypot(px, py, pz) || 1;
			return view(px / length, py / length, pz / length, t * 0.1, 0.3, sphere);
		}
		case 'constellation': {
			// Works wander on the globe under slow noise; the citations stay drawn.
			const wx = lx + 0.3 * (noise(i * 0.31 + 9, t * 0.24) - 0.5) * 2;
			const wy = ly + 0.3 * (noise(i * 0.53 + 27, t * 0.21) - 0.5) * 2;
			const wz = lz + 0.3 * (noise(i * 0.77 + 55, t * 0.27) - 0.5) * 2;
			const length = Math.hypot(wx, wy, wz) || 1;
			const p = view(wx / length, wy / length, wz / length, t * 0.12, 0.32, sphere);
			return { ...p, scale: p.scale * (1 + 0.25 * Math.sin(t * 1.4 + i * 2.7)) };
		}
		case 'sphere':
		default: {
			const p = projectOnSphere(x, y, sphere, t * 0.2);
			return p;
		}
	}
}

/** The quarter turns of the twisting bands: rapid moves scramble the globe, then replay backwards to solve it. */
const MOVES = 14;
const MOVE_SECONDS = 0.42;
const REST_SECONDS = 1.2;
const moves = Array.from({ length: MOVES }, (_, i) => {
	const axis = Math.min(2, Math.floor(hash(i, 2.3) * 3));
	const low = -1 + 0.5 * Math.min(3, Math.floor(hash(i, 5.9) * 4));
	return { axis, low, high: low + 0.5, angle: ((hash(i, 7.7) < 0.5 ? 1 : -1) * Math.PI) / 2 };
});

/** A point of the globe after the moves done at time t, and whether it is in the band turning now. */
function twist(x: number, y: number, z: number, t: number): [number, number, number, boolean] {
	const cycle = 2 * MOVES * MOVE_SECONDS + REST_SECONDS;
	const tc = t % cycle;
	const amount = new Array<number>(MOVES).fill(0);
	let active = -1;
	if (tc < 2 * MOVES * MOVE_SECONDS) {
		const slot = Math.floor(tc / MOVE_SECONDS);
		const p = Math.min(1, (tc - slot * MOVE_SECONDS) / MOVE_SECONDS / 0.7);
		const eased = 1 - (1 - p) ** 3;
		if (slot < MOVES) {
			for (let m = 0; m < slot; m++) amount[m] = 1;
			amount[slot] = eased;
			active = slot;
		} else {
			const back = 2 * MOVES - 1 - slot;
			for (let m = 0; m < back; m++) amount[m] = 1;
			amount[back] = 1 - eased;
			active = back;
		}
	}
	let inActive = false;
	moves.forEach((move, m) => {
		const share = amount[m] ?? 0;
		if (share <= 0) return;
		const coordinate = move.axis === 0 ? x : move.axis === 1 ? y : z;
		if (coordinate < move.low || coordinate >= move.high) return;
		if (m === active) inActive = true;
		const c = Math.cos(move.angle * share);
		const s = Math.sin(move.angle * share);
		if (move.axis === 0) [y, z] = [y * c - z * s, y * s + z * c];
		else if (move.axis === 1) [x, z] = [x * c + z * s, -x * s + z * c];
		else [x, y] = [x * c - y * s, x * s + y * c];
	});
	return [x, y, z, inActive];
}

/**
 * The signals of the constellation: bright packets running along citations,
 * each on a citation picked anew at each run. Returns, for each signal, the
 * index of its citation (among `count`) and how far along it is (0 to 1).
 */
export function signals(count: number, links: number, t: number): { link: number; along: number }[] {
	if (links === 0) return [];
	return Array.from({ length: count }, (_, s) => {
		const run = t * 0.55 + s * 7.31;
		return { link: Math.floor(hash(Math.floor(run), s * 3.1 + 1.7) * links) % links, along: frac(run) };
	});
}
