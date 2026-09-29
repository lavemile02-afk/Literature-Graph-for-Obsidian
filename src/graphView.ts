import { debounce, ItemView, Keymap, MarkdownView, Setting, TFile, ViewStateResult, WorkspaceLeaf, setIcon } from 'obsidian';
import { Application, Container, FederatedPointerEvent, Graphics, Mesh, MeshGeometry, Sprite, Text, Texture } from 'pixi.js';
import { approach, Camera, clampScale, fitCamera } from './camera';
import type { CitationIndex } from './citationIndex';
import { ColorGroup, colorFor, formatColorGroups, parseColorGroups } from './colorGroups';
import { edgeIndices, VERTICES_PER_EDGE, writeEdge } from './edgeGeometry';
import { LabelBox, placeLabels } from './labels';
import { buildGraph, GraphEdge, GraphNode, GraphOptions, LiteratureGraph } from './graphData';
import type { Forces, LayoutUpdate } from './layout';
import { LayoutRunner } from './layoutRunner';
import { openFileAtLine } from './navigation';
import type { OpenAlexClient } from './openalex';
import type { LiteratureGraphSettings } from './settings';

export const GRAPH_VIEW = 'literature-graph-graph';

/** Which citations the local graph follows from its center. */
type Direction = 'both' | 'out' | 'in';
const DIRECTIONS: Record<Direction, string> = {
	both: 'Cites and cited by',
	out: 'Cites (links)',
	in: 'Cited by (backlinks)',
};

interface SimNode {
	data: GraphNode;
	/** Place of the node in the layout's list. */
	index: number;
	/** Position given by the layout; undefined until its first step for a new work. */
	x?: number;
	y?: number;
	/** A white circle, tinted and scaled to the node's color and radius. */
	sprite: Sprite;
	/** Color of the node's color group, if any. */
	groupColor: ThemeColor | null;
	label: Text | null;
	radius: number;
	neighbors: Set<SimNode>;
}

interface SimLink {
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

/** A CSS color as "#rrggbb", for the color picker. */
function cssToHex(css: string): string {
	const { color } = parseCssColor(css, '#999999');
	return `#${color.toString(16).padStart(6, '0')}`;
}

/** Colors given to new groups, in turn. */
const GROUP_PALETTE = ['#d9a441', '#6fa8dc', '#8fbc6a', '#d4736a', '#b48ecf', '#5fb3a8'];

/** Starting zoom of the local graph. */
const LOCAL_START_SCALE = 1.5;
/** Radius of the shared circle texture, in pixels. */
const CIRCLE_TEXTURE_RADIUS = 32;
/** Largest node radius. */
const MAX_NODE_RADIUS = 40;
/** A node can be clicked this many pixels beyond its edge... */
const HIT_SLACK = 3;
/** ...and at least this many pixels from its center, however small it is on screen. */
const MIN_HIT_RADIUS = 8;
/** Labels appear when zoomed in past this scale (Obsidian's graph behaves the same). */
const LABEL_FADE_START = 0.7;
const LABEL_FADE_END = 1.2;
/** At most this many labels are shown for the works matching the filter. */
const MAX_FILTER_LABELS = 300;
/** At most this many labels of works outside the vault are shown around a hovered node. */
const MAX_NEIGHBOR_LABELS = 40;
/** Share of the way the hover highlight moves at each frame (a fade of about 150 ms). */
const FOCUS_FADE_STEP = 0.3;
/** Share of the way the camera and the wheel zoom move at each frame. */
const CAMERA_STEP = 0.14;
const ZOOM_STEP = 0.3;
/** Alpha of the edges that do not touch the hovered node. */
const DIMMED_EDGE_ALPHA = 0.08;
/** Arrowhead size, in pixels on screen; arrowheads are hidden when zoomed out past this scale. */
const ARROW_SIZE = 4;
const ARROW_MIN_SCALE = 0.5;

function radiusOf(node: GraphNode): number {
	const r = node.generation === 0 ? 4 + Math.sqrt(node.citedBy) * 2.2 : 2 + Math.sqrt(node.citedBy) * 1.2;
	return Math.min(MAX_NODE_RADIUS, r);
}

/**
 * A set of edges drawn as one mesh of one color: one draw call and one buffer
 * update per frame, however many edges there are.
 */
class EdgeMesh {
	readonly mesh: Mesh<MeshGeometry>;
	private links: SimLink[] = [];
	private positions: Float32Array<ArrayBufferLike> = new Float32Array(0);

	constructor() {
		this.mesh = new Mesh({ geometry: EdgeMesh.geometry(0), texture: Texture.WHITE });
	}

	/** A geometry for `count` edges (at least one, so the mesh stays valid). */
	private static geometry(count: number): MeshGeometry {
		const n = Math.max(1, count);
		const positions = new Float32Array(n * VERTICES_PER_EDGE * 2);
		return new MeshGeometry({ positions, uvs: new Float32Array(positions.length), indices: edgeIndices(n) });
	}

	setLinks(links: SimLink[]): void {
		this.links = links;
		const old = this.mesh.geometry;
		const geometry = EdgeMesh.geometry(links.length);
		this.positions = geometry.positions;
		this.mesh.geometry = geometry;
		old.destroy();
		this.mesh.visible = links.length > 0;
	}

	/** Moves the edges to their nodes' current positions. */
	update(width: number, arrow: number): void {
		if (this.links.length === 0) return;
		const out = this.positions;
		const ends = { x1: 0, y1: 0, x2: 0, y2: 0, targetRadius: 0 };
		this.links.forEach((link, i) => {
			ends.x1 = link.source.x ?? 0;
			ends.y1 = link.source.y ?? 0;
			ends.x2 = link.target.x ?? 0;
			ends.y2 = link.target.y ?? 0;
			ends.targetRadius = link.target.radius;
			writeEdge(out, i, ends, width, arrow);
		});
		this.mesh.geometry.getBuffer('aPosition').update();
	}

	style(color: ThemeColor, alpha: number): void {
		this.mesh.tint = color.color;
		this.mesh.alpha = alpha;
	}
}

/**
 * A graph view of the literature: the notes of the literature folder, the
 * citations between them (never wikilinks) and, optionally, the works outside
 * the vault that they cite (generation 1) and that those cite (generation 2),
 * drawn like Obsidian's graph view with its colors, with PixiJS and a d3-force
 * simulation.
 *
 * Nothing is drawn unless something changes: a frame is requested when the
 * layout moves, the pointer hovers a node, the camera moves or the data
 * changes, and frames stop when all is still (or when the view is hidden).
 */
export class LiteratureGraphView extends ItemView {
	private pixi: Application | null = null;
	private readonly world = new Container();
	private readonly vaultEdges = new EdgeMesh();
	private readonly outsideEdges = new EdgeMesh();
	private readonly focusEdges = new EdgeMesh();
	private readonly nodesLayer = new Container();
	private circleTexture: Texture | null = null;
	private readonly labelsLayer = new Container();
	/** The layout, run in a web worker. */
	private layout: LayoutRunner | null = null;
	/** Number of the graph last sent to the layout. */
	private layoutGraph = 0;
	private nodes: SimNode[] = [];
	private links: SimLink[] = [];
	private theme: Theme | null = null;
	/** The node under the pointer. */
	private hovered: SimNode | null = null;
	/** The node highlighted on screen: the hovered one, or the last one while its highlight fades out. */
	private shownFocus: SimNode | null = null;
	/** How much the highlight is shown, from 0 to 1. */
	private focusLevel = 0;
	private dragged: SimNode | null = null;
	private dragMoved = false;
	private dragStart = { x: 0, y: 0 };
	private panning: { x: number; y: number } | null = null;
	/** Wheel zoom in progress: the zoom to reach, and the point that stays under the pointer. */
	private zoom: { scale: number; px: number; py: number; wx: number; wy: number } | null = null;
	/** Where the camera goes by itself: fit the whole graph, center the local note, or nowhere (moved by the user). */
	private cameraMode: 'fit' | 'center' | null = 'fit';
	private frameId: number | null = null;
	private frameWindow: Window | null = null;
	/** Whether frames stopped because the view was hidden; they resume when it shows again. */
	private paused = false;
	/** The edges must be rebuilt at the next frame. */
	private edgesDirty = true;
	private lastEdgeScale = 0;
	private statusEl: HTMLElement | null = null;
	private controlsEl: HTMLElement | null = null;
	private hintEl: HTMLElement | null = null;
	private summary = '';
	/** Options of this view; start from the settings, changed only for this view. */
	options: GraphOptions;
	private loading = 0;
	/** Local mode: only the works around the active note, up to `depth` citations away. */
	private local = false;
	private depth = 1;
	/** Local mode: follow the citations of the center ("out"), the works citing it ("in"), or both. */
	private direction: Direction = 'both';
	/** Controls showing the view's state, updated when the state is restored. */
	private syncControls: (() => void)[] = [];
	/** Path of the note at the center of the local graph. */
	private center: string | null = null;
	/** The whole graph, of which the local mode shows a part. */
	private fullGraph: LiteratureGraph | null = null;
	/** Text typed in the filter: works whose label or title contain it stand out. */
	private filter = '';
	/** Hide the works that cite and are cited by none of the works shown. */
	private hideIsolated = false;
	/** Forces of the layout, changed with the sliders of the view. */
	private forces: Forces = { repel: 90, linkDistance: 60, center: 0.02 };
	private readonly reload = debounce(() => void this.loadData(), 2000, true);

	constructor(
		leaf: WorkspaceLeaf,
		private readonly index: CitationIndex,
		private readonly openAlex: OpenAlexClient,
		private readonly settings: () => LiteratureGraphSettings,
		/** Saves the color groups (in their text form) and recolors every graph view. */
		private readonly saveColorGroups: (text: string) => Promise<void>,
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
		return this.local ? 'Local literature graph' : 'Literature graph';
	}

	getState(): Record<string, unknown> {
		return { local: this.local, depth: this.depth, direction: this.direction };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as { local?: boolean; depth?: number; direction?: string };
		const wasLocal = this.local;
		this.local = s.local === true;
		this.depth = Math.min(3, Math.max(1, Number(s.depth) || 1));
		if (s.direction && s.direction in DIRECTIONS) this.direction = s.direction as Direction;
		await super.setState(state, result);
		for (const sync of this.syncControls) sync();
		if (this.local !== wasLocal) {
			this.contentEl.toggleClass('is-local', this.local);
			// A local graph is small: start closer, as Obsidian's local graph does.
			this.setCamera({ ...this.getCamera(), scale: this.local ? LOCAL_START_SCALE : 1 });
			this.cameraMode = this.local ? 'center' : 'fit';
			this.center = this.activeNotePath();
			this.showCurrent();
		}
	}

	/** The active note, or the last one active when a view that is not a note has the focus. */
	private activeNotePath(): string | null {
		const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? this.app.workspace.getActiveFile();
		return file?.path ?? null;
	}

	/** In local mode, centers the graph on the active note. */
	private followActiveNote(): void {
		if (!this.local) return;
		const path = this.activeNotePath();
		if (path && path !== this.center) {
			this.center = path;
			this.showCurrent();
		}
	}

	getIcon(): string {
		return 'network';
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass('literature-graph-view');
		this.statusEl = container.createDiv({ cls: 'literature-graph-view-status', text: 'Loading…' });
		this.hintEl = container.createDiv({ cls: 'literature-graph-view-hint is-hidden' });
		this.buildControls(container);

		const pixi = new Application();
		await pixi.init({
			width: Math.max(1, container.clientWidth),
			height: Math.max(1, container.clientHeight),
			backgroundAlpha: 0,
			antialias: true,
			resolution: activeWindow.devicePixelRatio,
			autoDensity: true,
			// Frames are drawn on demand (see `requestFrame`), not 60 times a second.
			autoStart: false,
		});
		pixi.ticker.stop();
		this.pixi = pixi;
		container.prepend(pixi.canvas);
		// One circle texture, drawn once, shared by every node.
		const circle = new Graphics().circle(CIRCLE_TEXTURE_RADIUS, CIRCLE_TEXTURE_RADIUS, CIRCLE_TEXTURE_RADIUS).fill(0xffffff);
		this.circleTexture = pixi.renderer.generateTexture({ target: circle, resolution: 2, antialias: true });
		circle.destroy();
		this.world.addChild(
			this.outsideEdges.mesh,
			this.vaultEdges.mesh,
			this.focusEdges.mesh,
			this.nodesLayer,
			this.labelsLayer,
		);
		pixi.stage.addChild(this.world);
		this.world.position.set(pixi.screen.width / 2, pixi.screen.height / 2);
		this.setUpInteractions(pixi);
		this.layout = new LayoutRunner(this.contentEl.win, (update) => this.onLayout(update));

		this.readTheme();
		this.registerEvent(
			this.app.workspace.on('css-change', () => {
				this.readTheme();
				this.invalidate();
			}),
		);
		this.registerEvent(this.index.on('changed', () => this.reload()));
		this.registerEvent(this.app.workspace.on('file-open', () => this.followActiveNote()));
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.followActiveNote();
				this.resume();
			}),
		);
		this.registerEvent(this.app.workspace.on('layout-change', () => this.resume()));
		await this.loadData();
	}

	onResize(): void {
		const pixi = this.pixi;
		if (!pixi) return;
		const width = this.contentEl.clientWidth;
		const height = this.contentEl.clientHeight;
		if (width > 0 && height > 0 && (width !== pixi.screen.width || height !== pixi.screen.height)) {
			// Keep the same point of the graph in the middle.
			const camera = this.getCamera();
			pixi.renderer.resize(width, height);
			this.setCamera(camera);
		}
		this.resume();
	}

	async onClose(): Promise<void> {
		this.loading++;
		this.layout?.destroy();
		this.layout = null;
		if (this.frameId !== null) this.frameWindow?.cancelAnimationFrame(this.frameId);
		this.frameId = null;
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
				if (run !== this.loading || !this.pixi) return;
				this.fullGraph = graph;
				this.showCurrent();
			},
			onStatus: (message) => {
				if (run === this.loading) this.setStatus(`${this.summary}${this.summary ? ' · ' : ''}${message}`);
			},
		});
		if (run === this.loading) {
			const limited = this.openAlex.isRateLimited ? ' · OpenAlex refuses requests for now: cached data only' : '';
			this.setStatus(this.summary + limited);
		}
	}

	/** Shows the whole graph, or in local mode the part around the active note. */
	private showCurrent(): void {
		if (!this.fullGraph || !this.pixi) return;
		if (!this.local) {
			this.show(this.withoutIsolated(this.fullGraph, null));
			return;
		}
		this.center ??= this.activeNotePath();
		this.cameraMode = 'center';
		this.show(this.withoutIsolated(this.localGraph(this.fullGraph, this.center), this.center));
	}

	/** The graph without the works that cite and are cited by none, when they are hidden (never the center). */
	private withoutIsolated(graph: LiteratureGraph, center: string | null): LiteratureGraph {
		if (!this.hideIsolated) return graph;
		const linked = new Set<string>();
		for (const e of graph.edges) {
			linked.add(e.source);
			linked.add(e.target);
		}
		return { ...graph, nodes: graph.nodes.filter((n) => linked.has(n.id) || n.id === center) };
	}

	/**
	 * The works at most `depth` citations away from the center, following
	 * citations in the chosen direction: the works it cites (and those they
	 * cite...), the works citing it (and those citing them...), or both. A center that is not a literature note (a draft that cites
	 * works, for example) is added with the works its citation links cite.
	 */
	private localGraph(graph: LiteratureGraph, center: string | null): LiteratureGraph {
		if (!center) return { nodes: [], edges: [], leftOut: 0 };
		const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
		const edges = [...graph.edges];
		if (!nodes.has(center)) {
			const file = this.app.vault.getAbstractFileByPath(center);
			if (!(file instanceof TFile)) return { nodes: [], edges: [], leftOut: 0 };
			nodes.set(center, {
				id: center,
				generation: 0,
				file,
				doi: null,
				openAlexId: null,
				label: file.basename,
				title: file.basename,
				citedBy: 0,
			});
			for (const link of this.index.linksFrom(file)) {
				const work = this.index.resolve(link.target, link.text);
				const target = work.kind === 'note' ? work.file.path : work.kind === 'doi' ? `doi:${work.doi}` : null;
				if (!target || target === center) continue;
				if (!nodes.has(target) && work.kind === 'doi') {
					nodes.set(target, {
						id: target,
						generation: 1,
						file: null,
						doi: work.doi,
						openAlexId: null,
						label: link.text,
						title: '',
						citedBy: 0,
					});
				}
				if (nodes.has(target)) edges.push({ source: center, target, sources: new Set(['link']) });
			}
		}
		const adjacent = new Map<string, Set<string>>();
		const connect = (a: string, b: string) => adjacent.set(a, (adjacent.get(a) ?? new Set<string>()).add(b));
		// An edge goes from the citing work (source) to the cited one (target).
		for (const e of edges) {
			if (this.direction !== 'in') connect(e.source, e.target);
			if (this.direction !== 'out') connect(e.target, e.source);
		}
		const kept = new Set([center]);
		let frontier = [center];
		for (let d = 0; d < this.depth; d++) {
			const next: string[] = [];
			for (const id of frontier) {
				for (const other of adjacent.get(id) ?? []) {
					if (!kept.has(other)) {
						kept.add(other);
						next.push(other);
					}
				}
			}
			frontier = next;
		}
		return {
			nodes: [...kept].flatMap((id) => {
				const node = nodes.get(id);
				return node ? [node] : [];
			}),
			edges: edges.filter((e) => kept.has(e.source) && kept.has(e.target)),
			leftOut: 0,
		};
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
		this.nodes = graph.nodes.map((data, index) => {
			const old = previous.get(data.id);
			const radius = radiusOf(data);
			const sprite = new Sprite(this.circleTexture ?? Texture.WHITE);
			sprite.anchor.set(0.5);
			sprite.scale.set(radius / CIRCLE_TEXTURE_RADIUS);
			this.nodesLayer.addChild(sprite);
			const node: SimNode = {
				data,
				index,
				x: old?.x,
				y: old?.y,
				sprite,
				groupColor: null,
				label: null,
				radius,
				neighbors: new Set(),
			};
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
		// The hovered node was replaced by a new one.
		this.hovered = this.hovered ? (byId.get(this.hovered.data.id) ?? null) : null;
		this.shownFocus = this.shownFocus ? (byId.get(this.shownFocus.data.id) ?? null) : null;
		this.dragged = null;
		if (!this.shownFocus) this.focusLevel = 0;

		const outside = (l: SimLink) => l.source.data.generation > 0 || l.target.data.generation > 0;
		this.vaultEdges.setLinks(this.links.filter((l) => !outside(l)));
		this.outsideEdges.setLinks(this.links.filter(outside));
		this.updateFocusEdges();

		this.applyColorGroups();
		if (this.local && this.nodes.length <= MAX_FILTER_LABELS) for (const node of this.nodes) this.ensureLabel(node);
		// Labels of the vault's works; others get one on hover.
		for (const node of this.nodes) if (node.data.generation === 0) this.ensureLabel(node);
		this.labelMatches();

		this.layout?.send({
			type: 'start',
			graph: ++this.layoutGraph,
			nodes: this.nodes.map((n) => ({ x: n.x, y: n.y, generation: n.data.generation, radius: n.radius })),
			links: this.links.map((l) => ({ source: l.source.index, target: l.target.index, inVault: !outside(l) })),
			forces: this.forces,
			alpha: previous.size > 0 ? 0.5 : 1,
		});

		const counts = [0, 0, 0];
		for (const n of this.nodes) counts[n.data.generation] = (counts[n.data.generation] ?? 0) + 1;
		const parts = [`${counts[0]} works of the vault`];
		if ((counts[1] ?? 0) > 0) parts.push(`${counts[1]} cited works outside it`);
		if ((counts[2] ?? 0) > 0) parts.push(`${counts[2]} of generation 2`);
		parts.push(`${this.links.length} citations`);
		if (graph.leftOut > 0) parts.push(`${graph.leftOut} works left out (node limit)`);
		this.summary = parts.join(' · ');
		this.setStatus(this.summary);
		this.invalidate();
	}

	/** Gives each note of the vault the color of its color group (settings). */
	applyColorGroups(): void {
		for (const sync of this.syncControls) sync();
		const s = this.settings();
		const colorOf = colorFor(this.app, parseColorGroups(s.graphColorGroups), s.titleProperty);
		for (const node of this.nodes) {
			const css = node.data.file ? colorOf(node.data.file) : null;
			node.groupColor = css ? parseCssColor(css, '#999999') : null;
		}
		this.invalidate();
	}

	/** The camera matching the current position and zoom of the graph. */
	private getCamera(): Camera {
		const scale = this.world.scale.x;
		const width = this.pixi?.screen.width ?? 0;
		const height = this.pixi?.screen.height ?? 0;
		return { x: (width / 2 - this.world.x) / scale, y: (height / 2 - this.world.y) / scale, scale };
	}

	private setCamera(camera: Camera): void {
		const width = this.pixi?.screen.width ?? 0;
		const height = this.pixi?.screen.height ?? 0;
		this.world.scale.set(camera.scale);
		this.world.position.set(width / 2 - camera.x * camera.scale, height / 2 - camera.y * camera.scale);
	}

	/** Where the camera is going by itself, if anywhere. */
	private cameraGoal(): Camera | null {
		if (this.cameraMode === 'fit') {
			const screen = this.pixi?.screen;
			if (!screen) return null;
			// The open control panel hides the right of the view: fit the graph beside it.
			const panel = this.controlsEl;
			const covered =
				panel && !panel.hasClass('is-collapsed') && panel.offsetWidth < screen.width / 2 ? panel.offsetWidth + 16 : 0;
			const width = screen.width - covered;
			const fit = fitCamera(this.nodes, width, screen.height, this.local ? LOCAL_START_SCALE : 1.5);
			if (fit) fit.x += covered / 2 / fit.scale;
			return fit;
		}
		if (this.cameraMode === 'center') {
			const node = this.nodes.find((n) => n.data.id === this.center);
			return node ? { x: node.x ?? 0, y: node.y ?? 0, scale: this.world.scale.x } : null;
		}
		return null;
	}

	/** Moves the camera so the whole graph is in view, and keeps it so while the layout moves. */
	fitToView(): void {
		this.cameraMode = 'fit';
		this.zoom = null;
		this.requestFrame();
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
		this.layout?.send({ type: 'forces', forces: { ...this.forces } });
	}

	/** New positions from the layout. */
	private onLayout(update: LayoutUpdate): void {
		// Positions of an older graph, sent before the layout got the new one.
		if (update.graph !== this.layoutGraph) return;
		const p = update.positions;
		for (const node of this.nodes) {
			// The dragged node is where the pointer is, which may be newer.
			if (node === this.dragged && this.dragMoved) continue;
			node.x = p[node.index * 2];
			node.y = p[node.index * 2 + 1];
		}
		this.edgesDirty = true;
		this.requestFrame();
	}

	/** The panel of the view, like the controls of Obsidian's graph view. */
	private buildControls(container: HTMLElement): void {
		const panel = container.createDiv({ cls: 'literature-graph-controls is-collapsed' });
		this.controlsEl = panel;
		const header = panel.createDiv({ cls: 'literature-graph-controls-header' });
		const fit = header.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': 'Fit the graph to the view' } });
		setIcon(fit, 'maximize');
		fit.addEventListener('click', () => this.fitToView());
		const toggle = header.createDiv({ cls: 'clickable-icon' });
		const body = panel.createDiv({ cls: 'literature-graph-controls-body' });
		/** Opens or closes the panel; its button is a gear when closed and a cross when open. */
		const setOpen = (open: boolean) => {
			panel.toggleClass('is-collapsed', !open);
			setIcon(toggle, open ? 'x' : 'settings');
			toggle.setAttribute('aria-label', open ? 'Close graph settings' : 'Open graph settings');
			// The room left for the graph changed.
			if (this.cameraMode === 'fit') this.requestFrame();
		};
		setOpen(false);
		toggle.addEventListener('click', () => setOpen(panel.hasClass('is-collapsed')));
		// A click anywhere outside the open panel closes it (and still does what it does).
		this.registerDomEvent(container.doc, 'pointerdown', (e: PointerEvent) => {
			// (No `instanceof Node`: in a pop-out window, nodes belong to another realm.)
			const target = e.target as Node | null;
			if (!panel.hasClass('is-collapsed') && target && !panel.contains(target)) setOpen(false);
		});

		const reloadSoon = debounce(() => void this.loadData(), 600, true);
		new Setting(body).setName('Filter').addSearch((search) =>
			search.setPlaceholder('Author, year or title').onChange((value) => {
				this.filter = value.trim().toLowerCase();
				this.labelMatches();
				this.invalidate();
			}),
		);
		new Setting(body)
			.setName('Depth')
			.setDesc('Local graph: how many citations away from the active note.')
			.setClass('literature-graph-local-only')
			.addSlider((slider) => {
				slider.setLimits(1, 3, 1).setValue(this.depth).onChange((value) => {
					this.depth = value;
					this.showCurrent();
					void this.app.workspace.requestSaveLayout();
				});
				this.syncControls.push(() => {
					slider.setValue(this.depth);
				});
			});
		new Setting(body)
			.setName('Direction')
			.setDesc('Local graph: the works the active note cites, the works citing it, or both.')
			.setClass('literature-graph-local-only')
			.addDropdown((dropdown) => {
				dropdown
					.addOptions(DIRECTIONS)
					.setValue(this.direction)
					.onChange((value) => {
						this.direction = value as Direction;
						this.showCurrent();
						void this.app.workspace.requestSaveLayout();
					});
				this.syncControls.push(() => {
					dropdown.setValue(this.direction);
				});
			});
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
		new Setting(body)
			.setName('Hide works without citations')
			.setDesc('Works that cite none of the works shown and are cited by none.')
			.addToggle((toggle) =>
				toggle.setValue(this.hideIsolated).onChange((value) => {
					this.hideIsolated = value;
					this.showCurrent();
				}),
			);
		this.buildGroups(body);
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
				.setLimits(0, 0.2, 0.005)
				.setValue(this.forces.center)
				.onChange((value) => {
					this.forces.center = value;
					this.applyForces();
				}),
		);
		new Setting(body).addButton((button) =>
			button.setButtonText('Restart layout').onClick(() => {
				this.layout?.send({ type: 'reheat', alpha: 1 });
				if (!this.local) this.cameraMode = 'fit';
				this.requestFrame();
			}),
		);
		body.createDiv({
			cls: 'setting-item-description',
			text: 'These changes last while this view is open; defaults are in the plugin settings.',
		});
	}

	/**
	 * The color groups, editable in the panel as in Obsidian's graph view: a
	 * query and a color per group, saved in the plugin settings (so every
	 * graph view uses them).
	 */
	private buildGroups(body: HTMLElement): void {
		new Setting(body)
			.setName('Groups')
			.setDesc('Color the notes that match a query: tag:#name, path:text, file:text, [property:value], or text.')
			.setHeading();
		const list = body.createDiv({ cls: 'literature-graph-groups' });
		let groups: ColorGroup[] = [];
		const save = () => void this.saveColorGroups(formatColorGroups(groups, this.settings().graphColorGroups));
		const saveSoon = debounce(save, 500, true);
		const render = () => {
			list.empty();
			groups.forEach((group, i) => {
				new Setting(list)
					.setClass('literature-graph-group')
					.addText((text) =>
						text
							.setPlaceholder('Query, such as tag:#name')
							.setValue(group.query)
							.onChange((value) => {
								group.query = value;
								saveSoon();
							}),
					)
					.addColorPicker((picker) =>
						picker.setValue(cssToHex(group.color)).onChange((value) => {
							group.color = value;
							save();
						}),
					)
					.addExtraButton((button) =>
						button
							.setIcon('x')
							.setTooltip('Remove this group')
							.onClick(() => {
								groups.splice(i, 1);
								save();
								render();
							}),
					);
			});
			new Setting(list).addButton((button) =>
				button.setButtonText('New group').onClick(() => {
					groups.push({ query: '', color: GROUP_PALETTE[groups.length % GROUP_PALETTE.length] ?? '#d9a441' });
					render();
					// The new group's query field, ready to type in.
					list.querySelectorAll<HTMLInputElement>('input[type="text"]').item(groups.length - 1)?.focus();
				}),
			);
		};
		groups = parseColorGroups(this.settings().graphColorGroups);
		render();
		// Groups changed elsewhere (settings tab, another graph view): show them,
		// unless this panel is being edited.
		this.syncControls.push(() => {
			if (!list.contains(list.doc.activeElement)) {
				groups = parseColorGroups(this.settings().graphColorGroups);
				render();
			}
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
		label.visible = false;
		node.label = label;
		this.labelsLayer.addChild(label);
		return label;
	}

	/** Something shown changed: draw everything again at the next frame. */
	private invalidate(): void {
		this.edgesDirty = true;
		this.requestFrame();
	}

	/** Asks for one frame; frames keep coming while something moves. */
	private requestFrame(): void {
		if (this.frameId !== null || !this.pixi || this.paused) return;
		const win = this.contentEl.win;
		this.frameWindow = win;
		this.frameId = win.requestAnimationFrame(() => {
			this.frameId = null;
			this.frame();
		});
	}

	/** Frames stopped while the view was hidden: start them again. */
	private resume(): void {
		if (!this.paused) return;
		this.paused = false;
		this.invalidate();
	}

	/**
	 * One frame: a step of the layout, of the hover highlight's fade and of the
	 * camera, then drawing. Asks for another frame while anything still moves.
	 */
	private frame(): void {
		const pixi = this.pixi;
		const theme = this.theme;
		if (!pixi || !theme) return;
		// A hidden view (another tab in front) costs nothing; `resume` restarts it.
		if (!this.contentEl.isShown()) {
			this.paused = true;
			return;
		}
		let again = false;

		// Hover highlight: fades in and out.
		const target = this.hovered ? 1 : 0;
		if (this.focusLevel !== target) {
			const step = target - this.focusLevel;
			this.focusLevel = Math.abs(step) < 0.02 ? target : this.focusLevel + step * FOCUS_FADE_STEP;
			this.focusLevel = Math.min(1, Math.max(0, this.focusLevel));
			again = true;
		}
		if (this.focusLevel === 0 && !this.hovered && this.shownFocus) {
			this.shownFocus = null;
			this.updateFocusEdges();
		}

		// Camera: a wheel zoom in progress, or the camera going by itself.
		const scaleBefore = this.world.scale.x;
		if (this.zoom) {
			const z = this.zoom;
			const next = approach({ x: 0, y: 0, scale: scaleBefore }, { x: 0, y: 0, scale: z.scale }, ZOOM_STEP).scale;
			this.world.scale.set(next);
			this.world.position.set(z.px - z.wx * next, z.py - z.wy * next);
			if (next === z.scale) this.zoom = null;
			else again = true;
		} else if (this.cameraMode) {
			const goal = this.cameraGoal();
			if (goal) {
				const current = this.getCamera();
				const next = approach(current, goal, CAMERA_STEP);
				this.setCamera(next);
				if (next.x !== goal.x || next.y !== goal.y || next.scale !== goal.scale) again = true;
			}
		}
		if (this.world.scale.x !== this.lastEdgeScale) this.edgesDirty = true;

		this.draw(theme);
		pixi.render();
		if (again) this.requestFrame();
	}

	/** Draws the edges (when needed), the nodes and the labels at their current positions. */
	private draw(theme: Theme): void {
		const scale = this.world.scale.x;
		const level = this.focusLevel;
		const focus = this.shownFocus;
		if (this.edgesDirty) {
			this.edgesDirty = false;
			this.lastEdgeScale = scale;
			const width = 1 / Math.max(scale, 0.5);
			const arrow = scale > ARROW_MIN_SCALE ? ARROW_SIZE / Math.max(scale, 1) : 0;
			this.vaultEdges.update(width, arrow);
			this.outsideEdges.update(width, arrow);
			this.focusEdges.update(width * 1.5, arrow);
		}
		const lerp = (a: number, b: number) => a + (b - a) * level;
		this.vaultEdges.style(theme.line, lerp(theme.line.alpha, DIMMED_EDGE_ALPHA));
		this.outsideEdges.style(theme.line, lerp(theme.line.alpha * 0.45, DIMMED_EDGE_ALPHA));
		this.focusEdges.style(theme.focused, theme.focused.alpha * level);

		for (const node of this.nodes) {
			const near = !focus || node === focus || focus.neighbors.has(node);
			const base =
				(node === focus && level > 0.5) || (this.local && node.data.id === this.center)
					? theme.focused
					: node.data.generation === 0
						? (node.groupColor ?? theme.node)
						: theme.unresolved;
			const genAlpha = node.data.generation === 2 ? 0.55 : 1;
			const sprite = node.sprite;
			sprite.position.set(node.x ?? 0, node.y ?? 0);
			sprite.tint = base.color;
			sprite.alpha = base.alpha * genAlpha * (near ? 1 : lerp(1, 0.2)) * (this.matches(node) ? 1 : 0.2);
		}

		// Labels: the vault's works fade in with the zoom; around a hovered node,
		// its neighbors' labels are shown too.
		const fade = Math.min(1, Math.max(0, (scale - LABEL_FADE_START) / (LABEL_FADE_END - LABEL_FADE_START)));
		const labelScale = 1 / Math.max(scale, 0.35);
		const screen = this.pixi?.screen;
		const candidates: { label: Text; box: LabelBox }[] = [];
		for (const node of this.nodes) {
			const label = node.label;
			if (!label) continue;
			const normal = this.filter
				? this.matches(node)
					? 1
					: 0
				: this.local
					? 1
					: node.data.generation === 0
						? fade
						: 0;
			let alpha = normal;
			let tier = node.data.generation === 0 ? 1 : 0;
			if (focus) {
				const near = node === focus || focus.neighbors.has(node);
				alpha = lerp(normal, near ? 1 : node.data.generation === 0 ? 0.1 * fade : 0);
				if (node === focus) tier = 4;
				else if (near) tier += 2;
			}
			label.visible = false;
			if (alpha <= 0.01) continue;
			label.alpha = alpha;
			label.position.set(node.x ?? 0, (node.y ?? 0) + node.radius + 3);
			label.scale.set(labelScale);
			// The label's box on screen; labels off screen are not drawn at all.
			const width = label.width * scale;
			const height = label.height * scale;
			const x = this.world.x + label.x * scale - width / 2;
			const y = this.world.y + label.y * scale;
			if (screen && (x > screen.width || y > screen.height || x + width < 0 || y + height < 0)) continue;
			candidates.push({ label, box: { x, y, width, height, priority: tier * 1e6 + node.data.citedBy } });
		}
		// Of labels that would cover one another, only the most important is shown.
		const shown = placeLabels(candidates.map((c) => c.box));
		candidates.forEach((c, i) => (c.label.visible = shown[i] ?? false));
	}

	/** The edges of the highlighted node, drawn over the others in the focus color. */
	private updateFocusEdges(): void {
		const focus = this.shownFocus;
		this.focusEdges.setLinks(focus ? this.links.filter((l) => l.source === focus || l.target === focus) : []);
		this.edgesDirty = true;
	}

	private setHovered(node: SimNode | null): void {
		if (this.dragged) return;
		this.hovered = node;
		this.showHint(node);
		if (node && node !== this.shownFocus) {
			this.shownFocus = node;
			this.ensureLabel(node);
			let shown = 0;
			for (const n of node.neighbors) {
				if (n.data.generation === 0 || shown++ < MAX_NEIGHBOR_LABELS) this.ensureLabel(n);
			}
			this.updateFocusEdges();
		}
		this.requestFrame();
	}

	/** The node under a point of the canvas, if any. */
	private nodeAt(global: { x: number; y: number }): SimNode | null {
		const p = this.world.toLocal(global);
		const scale = this.world.scale.x;
		// Every node can be hit within a few pixels of its edge, and at least
		// MIN_HIT_RADIUS pixels from its center, however small it is on screen;
		// when several can, the one whose edge is nearest the pointer wins.
		let best: SimNode | null = null;
		let bestGap = Infinity;
		for (const node of this.nodes) {
			if (node.x === undefined || node.y === undefined) continue;
			const reach = Math.max(node.radius + HIT_SLACK / scale, MIN_HIT_RADIUS / scale);
			const d = Math.hypot(node.x - p.x, node.y - p.y);
			if (d > reach) continue;
			const gap = d - node.radius;
			if (gap <= bestGap) {
				best = node;
				bestGap = gap;
			}
		}
		return best;
	}

	private startDrag(node: SimNode, event: FederatedPointerEvent): void {
		this.dragged = node;
		this.dragMoved = false;
		this.dragStart = { x: event.global.x, y: event.global.y };
	}

	/** What a click on a work opens, in words; null when there is nothing to open. */
	private openAction(node: SimNode): string | null {
		if (node.data.file) return 'Click to open the note';
		if (node.data.doi) return 'Click to open its DOI';
		if (node.data.openAlexId) return 'Click to open it on OpenAlex';
		return null;
	}

	/** Under the status line: the hovered work, and what a click on it opens. */
	private showHint(node: SimNode | null): void {
		const hint = this.hintEl;
		if (!hint) return;
		hint.empty();
		hint.toggleClass('is-hidden', !node);
		if (!node) return;
		const title = node.data.title && node.data.title !== node.data.label ? ` — ${node.data.title}` : '';
		hint.createSpan({ cls: 'literature-graph-view-hint-title', text: `${node.data.label}${title}` });
		const action = this.openAction(node);
		if (action) hint.createSpan({ cls: 'literature-graph-view-hint-action', text: ` · ${action}` });
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

	/** The user moved the view: the camera stops moving by itself. */
	private takeCamera(): void {
		this.cameraMode = null;
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
				if (!this.dragMoved && Math.hypot(e.global.x - this.dragStart.x, e.global.y - this.dragStart.y) > 3) {
					this.dragMoved = true;
					this.takeCamera();
				}
				if (!this.dragMoved) return;
				// The node follows the pointer at once; the layout moves the others.
				const p = this.world.toLocal(e.global);
				this.dragged.x = p.x;
				this.dragged.y = p.y;
				this.layout?.send({ type: 'drag', index: this.dragged.index, x: p.x, y: p.y });
				this.edgesDirty = true;
				this.requestFrame();
			} else if (this.panning) {
				this.takeCamera();
				this.zoom = null;
				this.world.position.set(e.global.x - this.panning.x, e.global.y - this.panning.y);
				this.requestFrame();
			} else {
				const node = this.nodeAt(e.global);
				pixi.canvas.style.cursor = node && this.openAction(node) ? 'pointer' : '';
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
			if (this.dragMoved) this.layout?.send({ type: 'release', index: node.index });
			if (!this.dragMoved) this.openNode(node, e);
			this.requestFrame();
		};
		stage.on('pointerup', release);
		stage.on('pointerupoutside', release);

		// Zoom around the pointer, smoothly: each wheel step changes the zoom to
		// reach, and the frames move toward it keeping the point under the pointer.
		pixi.canvas.addEventListener(
			'wheel',
			(e: WheelEvent) => {
				e.preventDefault();
				this.takeCamera();
				const rect = pixi.canvas.getBoundingClientRect();
				const px = e.clientX - rect.left;
				const py = e.clientY - rect.top;
				const scale = this.world.scale.x;
				const from = this.zoom?.scale ?? scale;
				// Pixel and line wheels (trackpads send many small pixel steps).
				const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
				this.zoom = {
					scale: clampScale(from * Math.exp(-delta * 0.0015)),
					px,
					py,
					wx: (px - this.world.x) / scale,
					wy: (py - this.world.y) / scale,
				};
				this.requestFrame();
			},
			{ passive: false },
		);
		// Double click on the background: fit the graph to the view.
		pixi.canvas.addEventListener('dblclick', (e: MouseEvent) => {
			const rect = pixi.canvas.getBoundingClientRect();
			if (!this.nodeAt({ x: e.clientX - rect.left, y: e.clientY - rect.top })) this.fitToView();
		});
	}
}
