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
	forceCenter,
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	ForceCenter,
	ForceLink,
	ForceManyBody,
	Simulation,
	SimulationLinkDatum,
	SimulationNodeDatum,
} from 'd3-force';

export interface LayoutNode extends SimulationNodeDatum {
	generation: number;
	radius: number;
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

/** With more nodes than this, the layout uses cheaper settings. */
const MANY_NODES = 1000;
/** Steps are at least this far apart (ms), so the layout moves at the pace of the screen. */
const STEP_INTERVAL = 16;
/** Alpha kept while a node is dragged, so the others follow it. */
const DRAG_ALPHA_TARGET = 0.3;

const linkDistance = (forces: Forces) => (l: LayoutLink) => (l.inVault ? forces.linkDistance : forces.linkDistance * 0.66);
const repel = (forces: Forces) => (n: LayoutNode) => (n.generation === 0 ? -forces.repel : -forces.repel * 0.28);

/** A stopped simulation of the graph; `tick` advances it. */
export function createSimulation(
	nodes: LayoutNode[],
	links: LayoutLink[],
	forces: Forces,
): Simulation<LayoutNode, LayoutLink> {
	const many = nodes.length > MANY_NODES;
	return (
		forceSimulation<LayoutNode, LayoutLink>(nodes)
			.force(
				'link',
				forceLink<LayoutNode, LayoutLink>(links)
					.distance(linkDistance(forces))
					.strength((l) => (l.inVault ? 0.4 : 0.15)),
			)
			.force('charge', forceManyBody<LayoutNode>().strength(repel(forces)).distanceMax(many ? 300 : 600))
			.force('center', forceCenter(0, 0).strength(forces.center))
			// Collisions cost much with many nodes, where they matter little.
			.force('collide', many ? null : forceCollide<LayoutNode>((n) => n.radius + 1))
			.stop()
	);
}

/** Changes the forces of a simulation. */
export function setForces(sim: Simulation<LayoutNode, LayoutLink>, forces: Forces): void {
	sim.force<ForceLink<LayoutNode, LayoutLink>>('link')?.distance(linkDistance(forces));
	sim.force<ForceManyBody<LayoutNode>>('charge')?.strength(repel(forces));
	sim.force<ForceCenter<LayoutNode>>('center')?.strength(forces.center);
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
				this.sim = createSimulation(this.nodes, links, message.forces).alpha(message.alpha);
				break;
			}
			case 'forces':
				if (this.sim) {
					setForces(this.sim, message.forces);
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
