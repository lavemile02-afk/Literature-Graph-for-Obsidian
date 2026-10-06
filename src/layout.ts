/**
 * The layout of the literature graph: a d3-force simulation, run step by step
 * by a `LayoutLoop`. The loop runs in a web worker (see `layoutWorker.ts`), so
 * that the layout of thousands of works does not slow down Obsidian; when a
 * worker cannot be started, the same loop runs in Obsidian itself.
 *
 * Nothing here knows about Obsidian or PixiJS: the view sends messages and
 * receives the positions of the nodes, in the order it gave them.
 */
import {
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	ForceX,
	ForceY,
	ForceLink,
	ForceManyBody,
	Simulation,
	SimulationLinkDatum,
	SimulationNodeDatum,
} from 'd3-force';
import { createAtomSimulation, setAtomSimulationForces } from './atomLayout';
import {
	createChronologicalSimulation,
	createCircleSimulation,
	createIslandsSimulation,
	createLayersSimulation,
	createMeaningSimulation,
	createTreeSimulation,
	createDendrogramSimulation,
} from './shapes';

export interface LayoutNode extends SimulationNodeDatum {
	depth: number;
	radius: number;
	/** Number of links of the node (set by `createSimulation`). */
	degree?: number;
	/** Year of publication, if known (the chronological and circle layouts). */
	year?: number | null;
	/** Place given by the work's meaning (the Meaning layout), or null. */
	anchor?: [number, number] | null;
	/** The works nearest in meaning (index, similarity), which it is drawn to in the Meaning layout. */
	kin?: [number, number][] | null;
}

export interface LayoutLink extends SimulationLinkDatum<LayoutNode> {
	/** Whether both works are notes of the vault (such links hold tighter). */
	inVault: boolean;
}

/** The forces the user can change in the view. */
export interface Forces {
	repel: number;
	linkDistance: number;
	center: number;
	/** How strongly works close in meaning draw together, in the meaning layouts (1: as by default). */
	meaning: number;
	/**
	 * In the meaning layouts, how strongly citations pull too (0: barely, as
	 * by default; 1: as strongly as in the default layout): meaning and
	 * citations together place a work whose text says little.
	 */
	citation?: number;
}

/**
 * Styles of layout: "default" (every work repelling the others, as in
 * Obsidian's graph view), "atom" (each work of the vault a nucleus with a
 * circle of the works it cites, see `atoms.ts`), and the shapes of
 * `shapes.ts`: "chronological", "islands", "layers", "circle", "meaning"
 * (groups of meaning in balls), "tree" (the semantic tree) and
 * "dendrogram" (groups, subgroups and works on a circle).
 */
export type LayoutStyle = 'default' | 'atom' | 'chronological' | 'islands' | 'layers' | 'circle' | 'meaning' | 'tree' | 'dendrogram';
export const LAYOUT_STYLES: Record<LayoutStyle, string> = {
	default: 'Default graph',
	atom: 'Atom graph',
	chronological: 'Chronological',
	islands: 'Islands',
	layers: 'Layers',
	circle: 'Circle',
	meaning: 'Meaning',
	tree: 'Meaning tree',
	dendrogram: 'Meaning dendrogram',
};

export function isLayoutStyle(value: unknown): value is LayoutStyle {
	return typeof value === 'string' && value in LAYOUT_STYLES;
}

/** The simulation of a style of layout. */
function createStyleSimulation(style: LayoutStyle, nodes: LayoutNode[], links: LayoutLink[], forces: Forces): Simulation<LayoutNode, LayoutLink> {
	switch (style) {
		case 'atom':
			return createAtomSimulation(nodes, links, forces);
		case 'chronological':
			return createChronologicalSimulation(nodes, links, forces);
		case 'islands':
			return createIslandsSimulation(nodes, links, forces);
		case 'layers':
			return createLayersSimulation(nodes, links, forces);
		case 'circle':
			return createCircleSimulation(nodes, links, forces);
		case 'meaning':
			return createMeaningSimulation(nodes, links, forces);
		case 'tree':
			return createTreeSimulation(nodes, links, forces);
		case 'dendrogram':
			return createDendrogramSimulation(nodes, links, forces);
		default:
			return createSimulation(nodes, links, forces);
	}
}

/** Messages from the view to the layout. */
export type LayoutMessage =
	| {
			type: 'start';
			/** Number of this graph, sent back with its positions. */
			graph: number;
			nodes: { x?: number; y?: number; vx?: number; vy?: number; depth: number; radius: number; year?: number | null; anchor?: [number, number] | null; kin?: [number, number][] | null }[];
			/** Indices into `nodes`. */
			links: { source: number; target: number; inVault: boolean }[];
			forces: Forces;
			alpha: number;
			/** "default" when left out. */
			style?: LayoutStyle;
	  }
	| { type: 'forces'; forces: Forces }
	| { type: 'reheat'; alpha: number }
	| { type: 'drag'; index: number; x: number; y: number }
	| { type: 'release'; index: number }
	| { type: 'stop' };

/** Positions sent back to the view after each step. */
export interface LayoutUpdate {
	/** The `graph` of the `start` message these positions belong to. */
	graph: number;
	/** x and y of each node, in the order of the `start` message. */
	positions: Float32Array;
	/** Whether the layout keeps moving (more updates will come). */
	moving: boolean;
}

/** Steps are at least this far apart (ms), so the layout moves at the pace of the screen. */
const STEP_INTERVAL = 16;
/** Alpha kept while a node is dragged, so the others follow it. */
const DRAG_ALPHA_TARGET = 0.3;
/**
 * The layout is frozen once no work has moved more than `FREEZE_SHARE` of
 * the graph's width (and at least `FREEZE_MOVE`, in graph units; a work's
 * radius is 4 or more) for `FREEZE_STEPS` steps in a row: a tenth of a pixel
 * or less when the whole graph is in view. What is left of its cooling would
 * not show, and would only keep the processor busy (measured on 9,700 works:
 * still after 7 s, cooled after 19 s). Dragging a work or changing a force
 * starts it again.
 */
export const FREEZE_MOVE = 0.05;
export const FREEZE_SHARE = 1e-4;
export const FREEZE_STEPS = 20;

const ends = (l: LayoutLink) => [l.source as LayoutNode, l.target as LayoutNode] as const;

/** A number between 0 and 1 that is always the same for the same link, to vary lengths without randomness. */
const jitter = (i: number) => ((i * 2654435761) >>> 0) / 4294967296;

/**
 * Length of a link: the chosen distance, plus room for the two nodes. A work
 * with a single link (often one of hundreds around a much-cited work) gets a
 * length that varies a little: with all the same length, they would sit on a
 * perfect circle around the work they cite.
 */
const linkDistance = (forces: Forces) => (l: LayoutLink, i: number) => {
	const [s, t] = ends(l);
	let d = forces.linkDistance * (l.inVault ? 1 : 0.8) + (s.radius + t.radius) * 1.5;
	if (Math.min(s.degree ?? 1, t.degree ?? 1) <= 1) d *= 0.7 + 0.6 * jitter(i);
	return d;
};

/**
 * Strength of a link, weaker for links of much-linked works (as d3 does by
 * default), so a work cited hundreds of times does not pull everything into
 * a tight ball.
 */
const linkStrength = (l: LayoutLink) => {
	const [s, t] = ends(l);
	return (l.inVault ? 1 : 0.7) / Math.max(1, Math.min(s.degree ?? 1, t.degree ?? 1));
};

/** Radius of a small work (outside the vault, rarely cited): the unit of the spacing. */
export const REFERENCE_RADIUS = 4;

/**
 * Repulsion in proportion to a work's radius, so the space between works
 * grows with their size: doubling the points doubles the room around them
 * (a request of the user), and larger (more cited) works get more room.
 */
export const repelFor = (forces: Forces, share = 1) => (n: LayoutNode) =>
	-forces.repel * share * Math.min(12, 1.36 * (n.radius / REFERENCE_RADIUS));

/** Works never overlap: a gap in proportion to their size. */
export const collideRadius = (n: LayoutNode) => n.radius * 1.25 + 1;

const repel = (forces: Forces) => repelFor(forces);

/**
 * A stopped simulation of the graph; `tick` advances it.
 *
 * Repulsion has no range limit: cutting it at a distance piles nodes up at
 * that distance, in rings. The center force is a weak pull of every node
 * toward the middle (like Obsidian's), not d3's `forceCenter`, which only
 * moves the whole graph and cannot spread or tighten it.
 */
export function createSimulation(
	nodes: LayoutNode[],
	links: LayoutLink[],
	forces: Forces,
): Simulation<LayoutNode, LayoutLink> {
	for (const n of nodes) n.degree = 0;
	for (const l of links) {
		const s = typeof l.source === 'number' ? nodes[l.source] : (l.source as LayoutNode);
		const t = typeof l.target === 'number' ? nodes[l.target] : (l.target as LayoutNode);
		if (s) s.degree = (s.degree ?? 0) + 1;
		if (t) t.degree = (t.degree ?? 0) + 1;
	}
	return forceSimulation<LayoutNode, LayoutLink>(nodes)
		.force('link', forceLink<LayoutNode, LayoutLink>(links).distance(linkDistance(forces)).strength(linkStrength))
		.force('charge', forceManyBody<LayoutNode>().strength(repel(forces)))
		.force('x', forceX<LayoutNode>(0).strength(forces.center))
		.force('y', forceY<LayoutNode>(0).strength(forces.center))
		.force('collide', forceCollide<LayoutNode>(collideRadius).strength(0.7))
		.stop();
}

/** Changes the forces of a simulation. */
export function setForces(sim: Simulation<LayoutNode, LayoutLink>, forces: Forces): void {
	sim.force<ForceLink<LayoutNode, LayoutLink>>('link')?.distance(linkDistance(forces));
	sim.force<ForceManyBody<LayoutNode>>('charge')?.strength(repel(forces));
	sim.force<ForceX<LayoutNode>>('x')?.strength(forces.center);
	sim.force<ForceY<LayoutNode>>('y')?.strength(forces.center);
}

/** Timer functions, from the worker or from Obsidian's window. */
export interface Timers {
	setTimeout(fn: () => void, ms: number): number;
	clearTimeout(id: number): void;
	now(): number;
}

/**
 * Runs the simulation: one step at most every `STEP_INTERVAL` ms while it
 * moves, sending the positions after each step, then stops until a message
 * sets it moving again.
 */
export class LayoutLoop {
	private sim: Simulation<LayoutNode, LayoutLink> | null = null;
	private style: LayoutStyle = 'default';
	private nodes: LayoutNode[] = [];
	/** The links of the graph, to build its simulation again when the forces of a shape change. */
	private links: LayoutLink[] = [];
	private graph = 0;
	private timer: number | null = null;
	private readonly dragged = new Set<number>();
	/** Positions sent last, and how many steps in a row nothing moved visibly (see `FREEZE_MOVE`). */
	private last: Float32Array | null = null;
	private stillSteps = 0;

	constructor(
		private readonly post: (update: LayoutUpdate) => void,
		private readonly timers: Timers,
	) {}

	handle(message: LayoutMessage): void {
		// Any message may set the works moving: count the still steps again.
		this.stillSteps = 0;
		switch (message.type) {
			case 'start': {
				this.graph = message.graph;
				this.nodes = message.nodes.map((n) => ({ ...n }));
				this.links = message.links.map((l) => ({ ...l }));
				this.dragged.clear();
				this.last = null;
				this.style = message.style ?? 'default';
				this.sim = createStyleSimulation(this.style, this.nodes, this.links, message.forces).alpha(message.alpha);
				break;
			}
			case 'forces':
				if (this.sim) {
					const alpha = Math.max(this.sim.alpha(), 0.5);
					if (this.style === 'atom') setAtomSimulationForces(this.sim, message.forces);
					else if (this.style === 'default') setForces(this.sim, message.forces);
					// The shapes: built again with the new forces, from where the works are.
					else this.sim = createStyleSimulation(this.style, this.nodes, this.links, message.forces);
					this.sim.alpha(alpha);
				}
				break;
			case 'reheat':
				this.sim?.alpha(message.alpha);
				break;
			case 'drag': {
				const node = this.nodes[message.index];
				if (!node || !this.sim) return;
				node.fx = node.x = message.x;
				node.fy = node.y = message.y;
				this.dragged.add(message.index);
				this.sim.alphaTarget(DRAG_ALPHA_TARGET);
				break;
			}
			case 'release': {
				const node = this.nodes[message.index];
				if (node) node.fx = node.fy = null;
				this.dragged.delete(message.index);
				if (this.dragged.size === 0) this.sim?.alphaTarget(0);
				break;
			}
			case 'stop':
				if (this.timer !== null) this.timers.clearTimeout(this.timer);
				this.timer = null;
				this.sim = null;
				this.nodes = [];
				this.last = null;
				return;
		}
		this.schedule(0);
	}

	private get moving(): boolean {
		const sim = this.sim;
		return sim !== null && (sim.alpha() >= sim.alphaMin() || this.dragged.size > 0);
	}

	private schedule(delay: number): void {
		if (this.timer !== null) return;
		this.timer = this.timers.setTimeout(() => {
			this.timer = null;
			this.step();
		}, delay);
	}

	private step(): void {
		const sim = this.sim;
		if (!sim) return;
		const started = this.timers.now();
		if (this.moving) sim.tick();
		const positions = new Float32Array(this.nodes.length * 2);
		this.nodes.forEach((n, i) => {
			positions[i * 2] = n.x ?? 0;
			positions[i * 2 + 1] = n.y ?? 0;
		});
		// Frozen once nothing moves visibly any more (never while a work is dragged).
		const last = this.last;
		if (last && last.length === positions.length && this.dragged.size === 0) {
			let most = 0;
			let min = Infinity;
			let max = -Infinity;
			for (let i = 0; i < positions.length; i++) {
				const p = positions[i] ?? 0;
				most = Math.max(most, Math.abs(p - (last[i] ?? 0)));
				min = Math.min(min, p);
				max = Math.max(max, p);
			}
			const still = Math.max(FREEZE_MOVE, (max - min) * FREEZE_SHARE);
			this.stillSteps = most < still ? this.stillSteps + 1 : 0;
			if (this.stillSteps >= FREEZE_STEPS) sim.alpha(0);
		}
		// (The array sent is handed over to the other side: keep a copy.)
		this.last = positions.slice();
		const moving = this.moving;
		this.post({ graph: this.graph, positions, moving });
		if (moving) this.schedule(Math.max(0, STEP_INTERVAL - (this.timers.now() - started)));
	}
}
