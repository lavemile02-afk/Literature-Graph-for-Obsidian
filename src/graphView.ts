import {
	forceCenter,
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	Simulation,
	SimulationLinkDatum,
	SimulationNodeDatum,
} from 'd3-force';
import { debounce, ItemView, Keymap, WorkspaceLeaf } from 'obsidian';
import { Application, Container, FederatedPointerEvent, Graphics, Text } from 'pixi.js';
import type { CitationIndex } from './citationIndex';
import { buildGeneration0, GraphEdge, GraphNode } from './graphData';
import { openFileAtLine } from './navigation';
import type { OpenAlexClient } from './openalex';
import type { LiteratureGraphSettings } from './settings';

export const GRAPH_VIEW = 'literature-graph-graph';

interface SimNode extends SimulationNodeDatum {
	data: GraphNode;
	circle: Graphics;
	label: Text;
	radius: number;
	neighbors: Set<SimNode>;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
	data: GraphEdge;
	source: SimNode;
	target: SimNode;
}

/** A color of the theme, read from a CSS variable, as Pixi wants it. */
interface ThemeColor {
	color: number;
	alpha: number;
}

interface Theme {
	node: ThemeColor;
	focused: ThemeColor;
	line: ThemeColor;
	text: ThemeColor;
	fontFamily: string;
}

/** Converts any CSS color to a number and an alpha, through a canvas. */
function parseCssColor(css: string, fallback: string): ThemeColor {
	const ctx = createEl('canvas').getContext('2d');
	if (!ctx) return { color: 0x888888, alpha: 1 };
	ctx.fillStyle = fallback;
	ctx.fillStyle = css.trim() || fallback;
	const value = ctx.fillStyle; // "#rrggbb" or "rgba(r, g, b, a)"
	if (value.startsWith('#')) return { color: Number.parseInt(value.slice(1), 16), alpha: 1 };
	const parts = /rgba?\(([^)]+)\)/.exec(value)?.[1]?.split(',').map((p) => Number.parseFloat(p)) ?? [];
	const [r = 136, g = 136, b = 136, a = 1] = parts;
	return { color: (r << 16) + (g << 8) + b, alpha: a };
}

/** Largest node radius, for hit testing. */
const MAX_NODE_RADIUS = 40;

/** Labels appear when zoomed in past this scale (Obsidian's graph behaves the same). */
const LABEL_FADE_START = 0.7;
const LABEL_FADE_END = 1.2;

/**
 * A graph view of the literature: the notes of the literature folder and the
 * citations between them (never wikilinks), drawn like Obsidian's graph view
 * with its colors, with PixiJS and a d3-force simulation.
 */
export class LiteratureGraphView extends ItemView {
	private pixi: Application | null = null;
	private world = new Container();
	private edgesLayer = new Graphics();
	private nodesLayer = new Container();
	private labelsLayer = new Container();
	private simulation: Simulation<SimNode, SimLink> | null = null;
	private nodes: SimNode[] = [];
	private links: SimLink[] = [];
	private theme: Theme | null = null;
	private hovered: SimNode | null = null;
	private dragged: SimNode | null = null;
	private dragMoved = false;
	private dragStart = { x: 0, y: 0 };
	private panning: { x: number; y: number } | null = null;
	private statusEl: HTMLElement | null = null;
	private readonly reload = debounce(() => void this.loadData(), 2000, true);

	constructor(
		leaf: WorkspaceLeaf,
		private readonly index: CitationIndex,
		private readonly openAlex: OpenAlexClient,
		private readonly settings: () => LiteratureGraphSettings,
	) {
		super(leaf);
	}

	getViewType(): string {
		return GRAPH_VIEW;
	}

	getDisplayText(): string {
		return 'Literature graph';
	}

	getIcon(): string {
		return 'network';
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass('literature-graph-view');
		this.statusEl = container.createDiv({ cls: 'literature-graph-view-status', text: 'Loading…' });

		const pixi = new Application();
		await pixi.init({
			resizeTo: container,
			backgroundAlpha: 0,
			antialias: true,
			resolution: activeWindow.devicePixelRatio,
			autoDensity: true,
		});
		this.pixi = pixi;
		container.prepend(pixi.canvas);
		this.world.addChild(this.edgesLayer, this.nodesLayer, this.labelsLayer);
		pixi.stage.addChild(this.world);
		this.world.position.set(pixi.screen.width / 2, pixi.screen.height / 2);
		this.setUpInteractions(pixi);

		this.readTheme();
		this.registerEvent(this.app.workspace.on('css-change', () => {
			this.readTheme();
			this.redraw();
		}));
		this.registerEvent(this.index.on('changed', () => this.reload()));
		await this.loadData();
	}

	async onClose(): Promise<void> {
		this.simulation?.stop();
		this.pixi?.destroy(true, { children: true });
		this.pixi = null;
	}

	private readTheme(): void {
		const style = getComputedStyle(activeDocument.body);
		const v = (name: string) => style.getPropertyValue(name);
		this.theme = {
			node: parseCssColor(v('--graph-node'), '#999999'),
			focused: parseCssColor(v('--graph-node-focused'), '#7f6df2'),
			line: parseCssColor(v('--graph-line'), '#555555'),
			text: parseCssColor(v('--graph-text'), '#dddddd'),
			fontFamily: v('--font-interface') || 'sans-serif',
		};
		for (const node of this.nodes) {
			node.label.style.fill = this.theme.text.color;
			node.label.style.fontFamily = this.theme.fontFamily;
		}
	}

	/** Builds the graph from the index and OpenAlex, keeping the positions of known nodes. */
	private async loadData(): Promise<void> {
		const graph = await buildGeneration0(this.app, this.index, this.openAlex, this.settings());
		if (!this.pixi) return;
		const previous = new Map(this.nodes.map((n) => [n.data.id, n]));
		for (const node of this.nodes) {
			node.circle.destroy();
			node.label.destroy();
		}
		this.nodesLayer.removeChildren();
		this.labelsLayer.removeChildren();

		const byId = new Map<string, SimNode>();
		this.nodes = graph.nodes.map((data) => {
			const old = previous.get(data.id);
			const node: SimNode = {
				data,
				x: old?.x,
				y: old?.y,
				circle: new Graphics(),
				label: new Text({
					text: data.label,
					style: { fontSize: 12, fill: this.theme?.text.color ?? 0xdddddd, fontFamily: this.theme?.fontFamily },
				}),
				radius: Math.min(MAX_NODE_RADIUS, 4 + Math.sqrt(data.citedBy) * 2.2),
				neighbors: new Set(),
			};
			node.label.anchor.set(0.5, 0);
			node.label.resolution = 2;
			this.nodesLayer.addChild(node.circle);
			this.labelsLayer.addChild(node.label);
			byId.set(data.id, node);
			return node;
		});
		this.links = graph.edges.flatMap((data) => {
			const source = byId.get(data.source);
			const target = byId.get(data.target);
			if (!source || !target) return [];
			source.neighbors.add(target);
			target.neighbors.add(source);
			return [{ data, source, target }];
		});

		this.simulation?.stop();
		this.simulation = forceSimulation<SimNode, SimLink>(this.nodes)
			.force('link', forceLink<SimNode, SimLink>(this.links).distance(60).strength(0.4))
			.force('charge', forceManyBody<SimNode>().strength(-90))
			.force('center', forceCenter(0, 0).strength(0.05))
			.force('collide', forceCollide<SimNode>((n) => n.radius + 2))
			.on('tick', () => this.redraw());
		if (previous.size > 0) this.simulation.alpha(0.3);

		const linked = this.nodes.filter((n) => n.neighbors.size > 0).length;
		this.statusEl?.setText(`${this.nodes.length} works · ${this.links.length} citations · ${linked} works with citations`);
	}

	/** Draws edges, nodes and labels at their current positions. */
	private redraw(): void {
		const theme = this.theme;
		if (!theme || !this.pixi) return;
		const scale = this.world.scale.x;
		const focus = this.hovered;
		const lit = (n: SimNode) => !focus || n === focus || focus.neighbors.has(n);

		const edges = this.edgesLayer;
		edges.clear();
		for (const link of this.links) {
			const { source: s, target: t } = link;
			const on = focus !== null && (s === focus || t === focus);
			const color = on ? theme.focused : theme.line;
			const alpha = focus && !on ? 0.15 : color.alpha;
			const x1 = s.x ?? 0;
			const y1 = s.y ?? 0;
			const x2 = t.x ?? 0;
			const y2 = t.y ?? 0;
			edges.moveTo(x1, y1).lineTo(x2, y2).stroke({ width: 1 / Math.max(scale, 0.5), color: color.color, alpha });
			// Arrowhead at the edge of the cited work.
			const len = Math.hypot(x2 - x1, y2 - y1);
			if (len > t.radius + 6) {
				const ux = (x2 - x1) / len;
				const uy = (y2 - y1) / len;
				const tipX = x2 - ux * (t.radius + 1);
				const tipY = y2 - uy * (t.radius + 1);
				const size = 4;
				edges
					.poly([
						tipX,
						tipY,
						tipX - ux * size * 1.6 - uy * size,
						tipY - uy * size * 1.6 + ux * size,
						tipX - ux * size * 1.6 + uy * size,
						tipY - uy * size * 1.6 - ux * size,
					])
					.fill({ color: color.color, alpha });
			}
		}

		const labelAlpha = Math.min(1, Math.max(0, (scale - LABEL_FADE_START) / (LABEL_FADE_END - LABEL_FADE_START)));
		for (const node of this.nodes) {
			const x = node.x ?? 0;
			const y = node.y ?? 0;
			const on = node === focus;
			const color = on ? theme.focused : theme.node;
			node.circle.clear().circle(x, y, node.radius).fill({ color: color.color, alpha: lit(node) ? color.alpha : 0.25 });
			node.label.position.set(x, y + node.radius + 3);
			node.label.scale.set(1 / Math.max(scale, 0.35));
			node.label.alpha = focus ? (lit(node) ? 1 : 0.1 * labelAlpha) : labelAlpha;
		}
	}

	private setHovered(node: SimNode | null): void {
		if (this.dragged) return;
		this.hovered = node;
		this.redraw();
	}

	/** The node under a point of the canvas, if any. */
	private nodeAt(global: { x: number; y: number }): SimNode | null {
		if (!this.simulation) return null;
		const p = this.world.toLocal(global);
		const slack = 3 / this.world.scale.x;
		const node = this.simulation.find(p.x, p.y, MAX_NODE_RADIUS + slack);
		if (!node) return null;
		return Math.hypot((node.x ?? 0) - p.x, (node.y ?? 0) - p.y) <= node.radius + slack ? node : null;
	}

	private startDrag(node: SimNode, event: FederatedPointerEvent): void {
		this.dragged = node;
		this.dragMoved = false;
		this.dragStart = { x: event.global.x, y: event.global.y };
		node.fx = node.x;
		node.fy = node.y;
		this.simulation?.alphaTarget(0.3).restart();
	}

	private setUpInteractions(pixi: Application): void {
		const stage = pixi.stage;
		stage.eventMode = 'static';
		stage.hitArea = pixi.screen;

		stage.on('pointerdown', (e: FederatedPointerEvent) => {
			const node = this.nodeAt(e.global);
			if (node) this.startDrag(node, e);
			else this.panning = { x: e.global.x - this.world.x, y: e.global.y - this.world.y };
		});
		stage.on('globalpointermove', (e: FederatedPointerEvent) => {
			if (this.dragged) {
				if (Math.hypot(e.global.x - this.dragStart.x, e.global.y - this.dragStart.y) > 3) this.dragMoved = true;
				if (!this.dragMoved) return;
				const p = this.world.toLocal(e.global);
				this.dragged.fx = p.x;
				this.dragged.fy = p.y;
			} else if (this.panning) {
				this.world.position.set(e.global.x - this.panning.x, e.global.y - this.panning.y);
				this.redraw();
			} else {
				const node = this.nodeAt(e.global);
				pixi.canvas.style.cursor = node ? 'pointer' : '';
				if (node !== this.hovered) this.setHovered(node);
			}
		});
		pixi.canvas.addEventListener('pointerleave', () => {
			if (!this.dragged) this.setHovered(null);
		});
		const release = (e: FederatedPointerEvent) => {
			const node = this.dragged;
			this.panning = null;
			if (!node) return;
			this.dragged = null;
			node.fx = null;
			node.fy = null;
			this.simulation?.alphaTarget(0);
			if (!this.dragMoved) {
				const newTab = e.button === 1 ? 'tab' : Keymap.isModEvent(e.nativeEvent as MouseEvent);
				void openFileAtLine(this.app, node.data.file, 0, newTab);
			}
		};
		stage.on('pointerup', release);
		stage.on('pointerupoutside', release);

		// Zoom around the pointer.
		pixi.canvas.addEventListener(
			'wheel',
			(e: WheelEvent) => {
				e.preventDefault();
				const factor = Math.exp(-e.deltaY * 0.0015);
				const scale = Math.min(6, Math.max(0.1, this.world.scale.x * factor));
				const rect = pixi.canvas.getBoundingClientRect();
				const px = e.clientX - rect.left;
				const py = e.clientY - rect.top;
				const wx = (px - this.world.x) / this.world.scale.x;
				const wy = (py - this.world.y) / this.world.scale.y;
				this.world.scale.set(scale);
				this.world.position.set(px - wx * scale, py - wy * scale);
				this.redraw();
			},
			{ passive: false },
		);
	}
}
