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
import { debounce, ItemView, Keymap, Setting, WorkspaceLeaf, setIcon } from 'obsidian';
import { Application, Container, FederatedPointerEvent, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { CitationIndex } from './citationIndex';
import { buildGraph, GraphEdge, GraphNode, GraphOptions, LiteratureGraph } from './graphData';
import { openFileAtLine } from './navigation';
import type { OpenAlexClient } from './openalex';
import type { LiteratureGraphSettings } from './settings';

export const GRAPH_VIEW = 'literature-graph-graph';

interface SimNode extends SimulationNodeDatum {
	data: GraphNode;
	/** A white circle, tinted and scaled to the node's color and radius. */
	sprite: Sprite;
	label: Text | null;
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
	unresolved: ThemeColor;
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

/** Radius of the shared circle texture, in pixels. */
const CIRCLE_TEXTURE_RADIUS = 32;
/** Largest node radius, for hit testing. */
const MAX_NODE_RADIUS = 40;
/** Labels appear when zoomed in past this scale (Obsidian's graph behaves the same). */
const LABEL_FADE_START = 0.7;
const LABEL_FADE_END = 1.2;
/** While the layout moves, about this many edges are redrawn per step (the rest wait). */
const EDGES_PER_FRAME = 4000;
/** At most this many labels are shown for the works matching the filter. */
const MAX_FILTER_LABELS = 300;
/** At most this many labels of works outside the vault are shown around a hovered node. */
const MAX_NEIGHBOR_LABELS = 40;

function radiusOf(node: GraphNode): number {
	const r = node.generation === 0 ? 4 + Math.sqrt(node.citedBy) * 2.2 : 2 + Math.sqrt(node.citedBy) * 1.2;
	return Math.min(MAX_NODE_RADIUS, r);
}

/**
 * A graph view of the literature: the notes of the literature folder, the
 * citations between them (never wikilinks) and, optionally, the works outside
 * the vault that they cite (generation 1) and that those cite (generation 2),
 * drawn like Obsidian's graph view with its colors, with PixiJS and a d3-force
 * simulation.
 */
export class LiteratureGraphView extends ItemView {
	private pixi: Application | null = null;
	private readonly world = new Container();
	private readonly edgesLayer = new Graphics();
	private readonly nodesLayer = new Container();
	private circleTexture: Texture | null = null;
	private readonly labelsLayer = new Container();
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
	private summary = '';
	/** Options of this view; start from the settings, changed only for this view. */
	options: GraphOptions;
	private loading = 0;
	/** Text typed in the filter: works whose label or title contain it stand out. */
	private filter = '';
	/** Forces of the layout, changed with the sliders of the view. */
	private forces = { repel: 90, linkDistance: 60, center: 0.05 };
	private ticks = 0;
	private readonly reload = debounce(() => void this.loadData(), 2000, true);

	constructor(
		leaf: WorkspaceLeaf,
		private readonly index: CitationIndex,
		private readonly openAlex: OpenAlexClient,
		private readonly settings: () => LiteratureGraphSettings,
	) {
		super(leaf);
		const s = settings();
		// The dropdown setting stores a string.
		this.options = {
			generations: Number(s.graphGenerations) || 0,
			minCitations: Math.max(1, Number(s.graphMinCitations) || 1),
			maxNodes: Math.max(100, Number(s.graphMaxNodes) || 3000),
		};
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
		this.buildControls(container);

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
		// One circle texture, drawn once, shared by every node.
		const circle = new Graphics().circle(CIRCLE_TEXTURE_RADIUS, CIRCLE_TEXTURE_RADIUS, CIRCLE_TEXTURE_RADIUS).fill(0xffffff);
		this.circleTexture = pixi.renderer.generateTexture({ target: circle, resolution: 2, antialias: true });
		circle.destroy();
		this.world.addChild(this.edgesLayer, this.nodesLayer, this.labelsLayer);
		pixi.stage.addChild(this.world);
		this.world.position.set(pixi.screen.width / 2, pixi.screen.height / 2);
		this.setUpInteractions(pixi);

		this.readTheme();
		this.registerEvent(
			this.app.workspace.on('css-change', () => {
				this.readTheme();
				this.redraw();
			}),
		);
		this.registerEvent(this.index.on('changed', () => this.reload()));
		await this.loadData();
	}

	async onClose(): Promise<void> {
		this.loading++;
		this.simulation?.stop();
		this.pixi?.destroy(true, { children: true });
		this.pixi = null;
	}

	private readTheme(): void {
		const style = getComputedStyle(activeDocument.body);
		const v = (name: string) => style.getPropertyValue(name);
		this.theme = {
			node: parseCssColor(v('--graph-node'), '#999999'),
			unresolved: parseCssColor(v('--graph-node-unresolved'), '#666666'),
			focused: parseCssColor(v('--graph-node-focused'), '#7f6df2'),
			line: parseCssColor(v('--graph-line'), '#555555'),
			text: parseCssColor(v('--graph-text'), '#dddddd'),
			fontFamily: v('--font-interface') || 'sans-serif',
		};
		for (const node of this.nodes) {
			if (!node.label) continue;
			node.label.style.fill = this.theme.text.color;
			node.label.style.fontFamily = this.theme.fontFamily;
		}
	}

	private setStatus(message: string): void {
		this.statusEl?.setText(message);
	}

	/** Builds the graph, generation by generation, and shows each stage. */
	async loadData(): Promise<void> {
		const run = ++this.loading;
		await buildGraph(this.app, this.index, this.openAlex, this.settings(), this.options, {
			onStage: (graph) => {
				if (run === this.loading && this.pixi) this.show(graph);
			},
			onStatus: (message) => {
				if (run === this.loading) this.setStatus(`${this.summary}${this.summary ? ' · ' : ''}${message}`);
			},
		});
		if (run === this.loading) this.setStatus(this.summary);
	}

	/** Shows a graph, keeping the positions of the nodes already shown. */
	private show(graph: LiteratureGraph): void {
		const previous = new Map(this.nodes.map((n) => [n.data.id, n]));
		for (const node of this.nodes) {
			node.label?.destroy();
			node.sprite.destroy();
		}
		this.nodesLayer.removeChildren();
		this.labelsLayer.removeChildren();

		const byId = new Map<string, SimNode>();
		this.nodes = graph.nodes.map((data) => {
			const old = previous.get(data.id);
			const radius = radiusOf(data);
			const sprite = new Sprite(this.circleTexture ?? Texture.WHITE);
			sprite.anchor.set(0.5);
			sprite.scale.set(radius / CIRCLE_TEXTURE_RADIUS);
			this.nodesLayer.addChild(sprite);
			const node: SimNode = { data, x: old?.x, y: old?.y, sprite, label: null, radius, neighbors: new Set() };
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
		// New works outside the vault start next to a work that cites them.
		for (const node of this.nodes) {
			if (node.x !== undefined) continue;
			const anchor = [...node.neighbors].find((n) => n.x !== undefined);
			if (anchor) {
				node.x = (anchor.x ?? 0) + (Math.random() - 0.5) * 60;
				node.y = (anchor.y ?? 0) + (Math.random() - 0.5) * 60;
			}
		}
		// Labels of the vault's works; others get one on hover.
		for (const node of this.nodes) if (node.data.generation === 0) this.ensureLabel(node);

		const many = this.nodes.length > 1000;
		const inVault = (l: SimLink) => l.source.data.generation === 0 && l.target.data.generation === 0;
		this.simulation?.stop();
		this.simulation = forceSimulation<SimNode, SimLink>(this.nodes)
			.force(
				'link',
				forceLink<SimNode, SimLink>(this.links)
					.distance((l) => (inVault(l) ? this.forces.linkDistance : this.forces.linkDistance * 0.66))
					.strength((l) => (inVault(l) ? 0.4 : 0.15)),
			)
			.force(
				'charge',
				forceManyBody<SimNode>()
					.strength((n) => (n.data.generation === 0 ? -this.forces.repel : -this.forces.repel * 0.28))
					.distanceMax(many ? 300 : 600),
			)
			.force('center', forceCenter(0, 0).strength(this.forces.center))
			// Collisions cost much with many nodes, where they matter little.
			.force('collide', many ? null : forceCollide<SimNode>((n) => n.radius + 1))
			.on('tick', () => this.onTick())
			.on('end', () => this.redraw());
		if (previous.size > 0) this.simulation.alpha(0.5);

		const counts = [0, 0, 0];
		for (const n of this.nodes) counts[n.data.generation] = (counts[n.data.generation] ?? 0) + 1;
		const parts = [`${counts[0]} works of the vault`];
		if ((counts[1] ?? 0) > 0) parts.push(`${counts[1]} cited works outside it`);
		if ((counts[2] ?? 0) > 0) parts.push(`${counts[2]} of generation 2`);
		parts.push(`${this.links.length} citations`);
		if (graph.leftOut > 0) parts.push(`${graph.leftOut} works left out (node limit)`);
		this.summary = parts.join(' · ');
		this.setStatus(this.summary);
	}

	/** Whether a work matches the filter (always true without a filter). */
	private matches(node: SimNode): boolean {
		if (!this.filter) return true;
		const text = `${node.data.label} ${node.data.title}`.toLowerCase();
		return text.includes(this.filter);
	}

	/** Labels for the works matching the filter (at most a few hundred). */
	private labelMatches(): void {
		if (!this.filter) return;
		let shown = 0;
		for (const node of this.nodes) if (this.matches(node) && shown++ < MAX_FILTER_LABELS) this.ensureLabel(node);
	}

	/** Changes the forces of the running layout. */
	private applyForces(): void {
		const sim = this.simulation;
		if (!sim) return;
		const inVault = (l: SimLink) => l.source.data.generation === 0 && l.target.data.generation === 0;
		sim.force<ForceLink<SimNode, SimLink>>('link')?.distance((l) =>
			inVault(l) ? this.forces.linkDistance : this.forces.linkDistance * 0.66,
		);
		sim.force<ForceManyBody<SimNode>>('charge')?.strength((n) =>
			n.data.generation === 0 ? -this.forces.repel : -this.forces.repel * 0.28,
		);
		sim.force<ForceCenter<SimNode>>('center')?.strength(this.forces.center);
		sim.alpha(0.5).restart();
	}

	/** The panel of the view, like the controls of Obsidian's graph view. */
	private buildControls(container: HTMLElement): void {
		const panel = container.createDiv({ cls: 'literature-graph-controls' });
		const header = panel.createDiv({ cls: 'literature-graph-controls-header' });
		const toggle = header.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': 'Show or hide the controls' } });
		setIcon(toggle, 'settings-2');
		const body = panel.createDiv({ cls: 'literature-graph-controls-body' });
		toggle.addEventListener('click', () => panel.toggleClass('is-collapsed', !panel.hasClass('is-collapsed')));

		const reloadSoon = debounce(() => void this.loadData(), 600, true);
		new Setting(body).setName('Filter').addSearch((search) =>
			search.setPlaceholder('Author, year or title').onChange((value) => {
				this.filter = value.trim().toLowerCase();
				this.labelMatches();
				this.redraw();
			}),
		);
		new Setting(body)
			.setName('Generations')
			.setDesc('Works outside the vault cited by it (1), and by those (2).')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ '0': '0', '1': '1', '2': '2' })
					.setValue(String(this.options.generations))
					.onChange((value) => {
						this.options.generations = Number(value);
						reloadSoon();
					}),
			);
		new Setting(body)
			.setName('Minimum citations')
			.setDesc('For a work outside the vault to be shown.')
			.addSlider((slider) =>
				slider
					.setLimits(1, 10, 1)
					.setValue(this.options.minCitations)
					.onChange((value) => {
						this.options.minCitations = value;
						reloadSoon();
					}),
			);
		new Setting(body).setName('Repel force').addSlider((slider) =>
			slider
				.setLimits(10, 300, 10)
				.setValue(this.forces.repel)
				.onChange((value) => {
					this.forces.repel = value;
					this.applyForces();
				}),
		);
		new Setting(body).setName('Link distance').addSlider((slider) =>
			slider
				.setLimits(20, 200, 10)
				.setValue(this.forces.linkDistance)
				.onChange((value) => {
					this.forces.linkDistance = value;
					this.applyForces();
				}),
		);
		new Setting(body).setName('Center force').addSlider((slider) =>
			slider
				.setLimits(0, 0.3, 0.01)
				.setValue(this.forces.center)
				.onChange((value) => {
					this.forces.center = value;
					this.applyForces();
				}),
		);
		new Setting(body).addButton((button) =>
			button.setButtonText('Restart layout').onClick(() => {
				this.simulation?.alpha(1).restart();
			}),
		);
		body.createDiv({
			cls: 'setting-item-description',
			text: 'These changes last while this view is open; defaults are in the plugin settings.',
		});
	}

	private ensureLabel(node: SimNode): Text {
		if (node.label) return node.label;
		const label = new Text({
			text: node.data.label,
			style: { fontSize: 12, fill: this.theme?.text.color ?? 0xdddddd, fontFamily: this.theme?.fontFamily },
		});
		label.anchor.set(0.5, 0);
		label.resolution = 2;
		node.label = label;
		this.labelsLayer.addChild(label);
		return label;
	}

	/**
	 * Called at each step of the layout. With many edges, rebuilding them is
	 * the slowest part, so they are redrawn only every few steps while the
	 * layout moves; nodes are redrawn at every step.
	 */
	private onTick(): void {
		this.ticks++;
		const every = Math.max(1, Math.ceil(this.links.length / EDGES_PER_FRAME));
		const settling = (this.simulation?.alpha() ?? 0) > 0.02;
		this.redraw(!settling || this.ticks % every === 0);
	}

	/** Draws nodes and labels (and edges, unless told not to) at their current positions. */
	private redraw(withEdges = true): void {
		const theme = this.theme;
		if (!theme || !this.pixi) return;
		const scale = this.world.scale.x;
		const focus = this.hovered;
		const lit = (n: SimNode) => (!focus || n === focus || focus.neighbors.has(n)) && this.matches(n);
		if (withEdges) this.drawEdges(theme, scale, focus);
		this.drawNodes(theme, scale, focus, lit);
	}

	private drawEdges(theme: Theme, scale: number, focus: SimNode | null): void {
		const width = 1 / Math.max(scale, 0.5);
		const edges = this.edgesLayer;
		edges.clear();
		for (const link of this.links) {
			const { source: s, target: t } = link;
			const on = focus !== null && (s === focus || t === focus);
			const outside = s.data.generation > 0 || t.data.generation > 0;
			const color = on ? theme.focused : theme.line;
			const alpha = focus && !on ? 0.08 : outside && !on ? color.alpha * 0.45 : color.alpha;
			const x1 = s.x ?? 0;
			const y1 = s.y ?? 0;
			const x2 = t.x ?? 0;
			const y2 = t.y ?? 0;
			edges.moveTo(x1, y1).lineTo(x2, y2).stroke({ width, color: color.color, alpha });
			// Arrowhead at the edge of the cited work, when zoomed in enough to see it.
			const len = Math.hypot(x2 - x1, y2 - y1);
			if (scale > 0.5 && len > t.radius + 6) {
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
	}

	private drawNodes(theme: Theme, scale: number, focus: SimNode | null, lit: (n: SimNode) => boolean): void {
		for (const node of this.nodes) {
			const base = node === focus ? theme.focused : node.data.generation === 0 ? theme.node : theme.unresolved;
			const genAlpha = node.data.generation === 2 ? 0.55 : 1;
			const sprite = node.sprite;
			sprite.position.set(node.x ?? 0, node.y ?? 0);
			sprite.tint = base.color;
			sprite.alpha = base.alpha * genAlpha * (lit(node) ? 1 : 0.2);
		}

		// Labels: the vault's works fade in with the zoom; around a hovered node,
		// its neighbors' labels are shown too.
		const fade = Math.min(1, Math.max(0, (scale - LABEL_FADE_START) / (LABEL_FADE_END - LABEL_FADE_START)));
		if (focus) {
			this.ensureLabel(focus);
			let shown = 0;
			for (const n of focus.neighbors) {
				if (n.data.generation === 0 || shown++ < MAX_NEIGHBOR_LABELS) this.ensureLabel(n);
			}
		}
		for (const node of this.nodes) {
			const label = node.label;
			if (!label) continue;
			label.position.set(node.x ?? 0, (node.y ?? 0) + node.radius + 3);
			label.scale.set(1 / Math.max(scale, 0.35));
			const nearFocus = focus !== null && (node === focus || focus.neighbors.has(node));
			if (focus) label.alpha = nearFocus ? 1 : node.data.generation === 0 ? 0.1 * fade : 0;
			else if (this.filter) label.alpha = this.matches(node) ? 1 : 0;
			else label.alpha = node.data.generation === 0 ? fade : 0;
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

	/** Opens a work: its note, or else its DOI or OpenAlex page. */
	private openNode(node: SimNode, event: FederatedPointerEvent): void {
		const data = node.data;
		if (data.file) {
			const newTab = event.button === 1 ? 'tab' : Keymap.isModEvent(event.nativeEvent as MouseEvent);
			void openFileAtLine(this.app, data.file, 0, newTab);
		} else if (data.doi) {
			window.open(`https://doi.org/${data.doi}`);
		} else if (data.openAlexId) {
			window.open(`https://openalex.org/${data.openAlexId}`);
		}
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
			if (!this.dragMoved) this.openNode(node, e);
		};
		stage.on('pointerup', release);
		stage.on('pointerupoutside', release);

		// Zoom around the pointer.
		pixi.canvas.addEventListener(
			'wheel',
			(e: WheelEvent) => {
				e.preventDefault();
				const factor = Math.exp(-e.deltaY * 0.0015);
				const scale = Math.min(6, Math.max(0.05, this.world.scale.x * factor));
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
