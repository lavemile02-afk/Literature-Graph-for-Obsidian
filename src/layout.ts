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

export interface LayoutNode extends SimulationNodeDatum {
	generation: number;
	radius: number;
	/** Number of links of the node (set by `createSimulation`). */
	degree?: number;
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
}

/**
 * Styles of layout: "default" (every work repelling the others, as in
 * Obsidian's graph view) or "atom" (each work of the vault a nucleus with a
 * circle of the works it cites, see `atoms.ts`). Others may be added.
 */
export type LayoutStyle = 'default' | 'atom';
export const LAYOUT_STYLES: Record<LayoutStyle, string> = {
	default: 'Default graph',
	atom: 'Atom graph',
};

/** Messages from the view to the layout. */
export type LayoutMessage =
	| {
			type: 'start';
			/** Number of this graph, sent back with its positions. */
			graph: number;
			nodes: { x?: number; y?: number; vx?: number; vy?: number; generation: number; radius: number }[];
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

/** Repulsion, larger for larger (more cited) works, which then get room around them. */
const repel = (forces: Forces) => (n: LayoutNode) => -forces.repel * Math.min(4, 0.35 + n.radius / 6);

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
		.force('collide', forceCollide<LayoutNode>((n) => n.radius + 2).strength(0.7))
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
	private graph = 0;
	private timer: number | null = null;
	private readonly dragged = new Set<number>();

	constructor(
		private readonly post: (update: LayoutUpdate) => void,
		private readonly timers: Timers,
	) {}

	handle(message: LayoutMessage): void {
		switch (message.type) {
			case 'start': {
				this.graph = message.graph;
				this.nodes = message.nodes.map((n) => ({ ...n }));
				const links = message.links.map((l) => ({ ...l }));
				this.dragged.clear();
				this.style = message.style ?? 'default';
				this.sim = (
					this.style === 'atom'
						? createAtomSimulation(this.nodes, links, message.forces)
						: createSimulation(this.nodes, links, message.forces)
				).alpha(message.alpha);
				break;
			}
			case 'forces':
				if (this.sim) {
					if (this.style === 'atom') setAtomSimulationForces(this.sim, message.forces);
					else setForces(this.sim, message.forces);
					this.sim.alpha(Math.max(this.sim.alpha(), 0.5));
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
		const moving = this.moving;
		this.post({ graph: this.graph, positions, moving });
		if (moving) this.schedule(Math.max(0, STEP_INTERVAL - (this.timers.now() - started)));
	}
}
