/**
 * The "Atom graph" layout style: each work of the vault is a nucleus, with a
 * circle of the works outside the vault that it cites (see `atoms.ts`).
 *
 * - Electrons are held at their place in the cloud relative to their nucleus
 *   (`orbit`), so a cloud moves with its nucleus and keeps its shape.
 * - Clouds, and free works (cited by several atoms), do not overlap: a strong
 *   repulsion acts only where they would (`clouds`), not over a long range.
 * - Nuclei and free works repel each other, the citations between works of
 *   the vault hold their atoms side by side, and a weak pull toward the middle
 *   gives the whole a round shape.
 */
import { Force, forceLink, forceManyBody, forceSimulation, forceX, forceY, ForceLink, Simulation } from 'd3-force';
import { Atoms, buildAtoms, ELECTRON, NUCLEUS } from './atoms';
import type { Forces, LayoutLink, LayoutNode } from './layout';

/** Distance between neighboring electrons in a cloud. */
const ELECTRON_SPACING = 16;
/** How strongly an electron is pulled to its place, at each step (share of the distance). */
const ORBIT_STRENGTH = 0.25;
/** How much of an overlap between clouds is undone at each step. */
const CLOUD_STIFFNESS = 0.6;
/** Room kept between two clouds, and between a cloud and a free work. */
const CLOUD_GAP = 12;
const FREE_GAP = 3;

/** Electrons follow their place in their nucleus's cloud. */
function orbit(atoms: Atoms): Force<LayoutNode, LayoutLink> {
	let nodes: LayoutNode[] = [];
	const force = () => {
		nodes.forEach((n, i) => {
			if (atoms.role[i] !== ELECTRON || n.fx != null) return;
			const c = nodes[atoms.nucleus[i] ?? -1];
			if (!c) return;
			n.vx = (n.vx ?? 0) + ((c.x ?? 0) + (atoms.dx[i] ?? 0) - (n.x ?? 0)) * ORBIT_STRENGTH;
			n.vy = (n.vy ?? 0) + ((c.y ?? 0) + (atoms.dy[i] ?? 0) - (n.y ?? 0)) * ORBIT_STRENGTH;
		});
	};
	force.initialize = (ns: LayoutNode[]) => {
		nodes = ns;
	};
	return force;
}

/**
 * Clouds (nuclei with their cloud's radius) and free works (with their own
 * radius) push apart where they overlap, the larger moving less. Neighbors
 * are found through a grid of cells as large as the largest pair of clouds.
 */
function clouds(atoms: Atoms, gap: () => number): Force<LayoutNode, LayoutLink> {
	let nodes: LayoutNode[] = [];
	let bodies: number[] = [];
	const force = () => {
		const radius = (i: number) => atoms.cloud[i] ?? 0;
		let largest = 1;
		for (const i of bodies) largest = Math.max(largest, radius(i));
		const cell = 2 * largest + gap();
		const grid = new Map<string, number[]>();
		const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
		for (const i of bodies) {
			const n = nodes[i];
			if (!n) continue;
			const k = key(n.x ?? 0, n.y ?? 0);
			const list = grid.get(k);
			if (list) list.push(i);
			else grid.set(k, [i]);
		}
		for (const i of bodies) {
			const a = nodes[i];
			if (!a) continue;
			const cx = Math.floor((a.x ?? 0) / cell);
			const cy = Math.floor((a.y ?? 0) / cell);
			for (let gx = cx - 1; gx <= cx + 1; gx++) {
				for (let gy = cy - 1; gy <= cy + 1; gy++) {
					for (const j of grid.get(`${gx},${gy}`) ?? []) {
						if (j <= i) continue;
						const b = nodes[j];
						if (!b) continue;
						const bothNuclei = atoms.role[i] === NUCLEUS && atoms.role[j] === NUCLEUS;
						const min = radius(i) + radius(j) + (bothNuclei ? gap() : FREE_GAP);
						let dx = (b.x ?? 0) - (a.x ?? 0);
						let dy = (b.y ?? 0) - (a.y ?? 0);
						let d = Math.hypot(dx, dy);
						if (d >= min) continue;
						if (d < 1e-6) {
							dx = (i % 7) - 3 + 0.5;
							dy = (j % 5) - 2 + 0.5;
							d = Math.hypot(dx, dy);
						}
						const push = ((min - d) / d) * CLOUD_STIFFNESS;
						// The larger cloud moves less.
						const wa = radius(j) / (radius(i) + radius(j));
						const wb = 1 - wa;
						a.vx = (a.vx ?? 0) - dx * push * wa;
						a.vy = (a.vy ?? 0) - dy * push * wa;
						b.vx = (b.vx ?? 0) + dx * push * wb;
						b.vy = (b.vy ?? 0) + dy * push * wb;
					}
				}
			}
		}
	};
	force.initialize = (ns: LayoutNode[]) => {
		nodes = ns;
		bodies = ns.map((_, i) => i).filter((i) => atoms.role[i] !== ELECTRON);
	};
	return force;
}

/** A stopped "Atom graph" simulation; `tick` advances it. */
export function createAtomSimulation(
	nodes: LayoutNode[],
	links: LayoutLink[],
	forces: Forces,
): Simulation<LayoutNode, LayoutLink> {
	const atoms = buildAtoms(
		nodes,
		links.map((l) => ({ source: l.source as number, target: l.target as number })),
		ELECTRON_SPACING,
	);
	const atomOf = (n: LayoutNode) => {
		const i = n.index ?? -1;
		return atoms.role[i] === NUCLEUS ? i : atoms.role[i] === ELECTRON ? (atoms.nucleus[i] ?? -1) : -1;
	};
	const degree = new Map<number, number>();
	for (const l of links) {
		for (const end of [l.source, l.target] as number[]) degree.set(end, (degree.get(end) ?? 0) + 1);
	}
	// Start electrons at their place, when their nucleus has a position.
	nodes.forEach((n, i) => {
		const c = nodes[atoms.nucleus[i] ?? -1];
		if (atoms.role[i] === ELECTRON && n.x === undefined && c?.x !== undefined && c.y !== undefined) {
			n.x = c.x + (atoms.dx[i] ?? 0);
			n.y = c.y + (atoms.dy[i] ?? 0);
		}
	});
	const simulation = forceSimulation<LayoutNode, LayoutLink>(nodes)
		.force('orbit', orbit(atoms))
		.force('link', forceLink<LayoutNode, LayoutLink>(links));
	setAtomForces(simulation, forces, atoms, atomOf, degree);
	(simulation as AtomSimulation).atoms = { atoms, atomOf, degree };
	return simulation.stop();
}

type AtomSimulation = Simulation<LayoutNode, LayoutLink> & {
	atoms?: { atoms: Atoms; atomOf: (n: LayoutNode) => number; degree: Map<number, number> };
};

/**
 * The forces that the view's sliders change: repulsion between nuclei and
 * free works (none for electrons, held by their orbit), links (none inside
 * an atom; between two atoms, long enough for their clouds to touch), and the
 * pull toward the middle.
 */
function setAtomForces(
	simulation: Simulation<LayoutNode, LayoutLink>,
	forces: Forces,
	atoms: Atoms,
	atomOf: (n: LayoutNode) => number,
	degree: Map<number, number>,
): void {
	const role = (n: LayoutNode) => atoms.role[n.index ?? -1];
	const cloud = (n: LayoutNode) => atoms.cloud[n.index ?? -1] ?? n.radius;
	const sameAtom = (l: LayoutLink) => {
		const a = atomOf(l.source as LayoutNode);
		return a >= 0 && a === atomOf(l.target as LayoutNode);
	};
	simulation
		.force<ForceLink<LayoutNode, LayoutLink>>('link')
		?.distance((l) => {
			const s = l.source as LayoutNode;
			const t = l.target as LayoutNode;
			if (role(s) === NUCLEUS && role(t) === NUCLEUS) return cloud(s) + cloud(t) + CLOUD_GAP + forces.linkDistance / 4;
			return forces.linkDistance + cloud(s) * (role(s) === NUCLEUS ? 1 : 0) + cloud(t) * (role(t) === NUCLEUS ? 1 : 0);
		})
		.strength((l) => {
			if (sameAtom(l)) return 0;
			const s = l.source as LayoutNode;
			const t = l.target as LayoutNode;
			if (role(s) === NUCLEUS && role(t) === NUCLEUS) return 0.3;
			const d = Math.min(degree.get(s.index ?? -1) ?? 1, degree.get(t.index ?? -1) ?? 1);
			return 0.5 / Math.max(1, d);
		});
	// The gap between clouds follows the "link distance" slider.
	simulation.force('clouds', clouds(atoms, () => CLOUD_GAP + forces.linkDistance / 4));
	simulation.force(
		'charge',
		forceManyBody<LayoutNode>().strength((n) =>
			role(n) === ELECTRON ? 0 : role(n) === NUCLEUS ? -forces.repel * Math.min(6, 1 + cloud(n) / 40) : -forces.repel * 0.4,
		),
	);
	const gravity = (n: LayoutNode) => (role(n) === ELECTRON ? 0 : forces.center);
	simulation.force('x', forceX<LayoutNode>(0).strength(gravity));
	simulation.force('y', forceY<LayoutNode>(0).strength(gravity));
}

/** Changes the forces of an "Atom graph" simulation. */
export function setAtomSimulationForces(simulation: Simulation<LayoutNode, LayoutLink>, forces: Forces): void {
	const data = (simulation as AtomSimulation).atoms;
	if (!data) return;
	setAtomForces(simulation, forces, data.atoms, data.atomOf, data.degree);
}
