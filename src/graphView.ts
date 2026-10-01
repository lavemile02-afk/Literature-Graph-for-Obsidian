import { debounce, ItemView, Keymap, MarkdownView, Notice, Setting, SliderComponent, TFile, ViewStateResult, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import { Application, Container, Graphics, Mesh, MeshGeometry, Sprite, Text, Texture } from 'pixi.js';
import { approach, Camera, clampScale, fitCamera } from './camera';
import type { CitationIndex } from './citationIndex';
import { ColorGroup, colorFor, formatColorGroups, parseColorGroups } from './colorGroups';
import { hexColor, mixColor } from './colors';
import { QuerySuggest, showNewGroupMenu } from './groupMenu';
import { collectQueryData } from './groupQueries';
import { edgeIndices, VERTICES_PER_EDGE, writeEdge } from './edgeGeometry';
import { LabelBox, placeLabels } from './labels';
import { buildGraph, EdgeSource, GraphEdge, GraphNode, GraphOptions, LiteratureGraph } from './graphData';
import { Forces, isLayoutStyle, LAYOUT_STYLES, LayoutStyle, LayoutUpdate } from './layout';
import { CHRONOLOGICAL_POINT_SCALE, timelineWidth, unknownYearX, yearScale } from './shapes';
import { LayoutRunner } from './layoutRunner';
import { openFileAtLine } from './navigation';
import type { GhostNoteStore } from './ghostNotes';
import type { PositionStore } from './positions';
import { cachedInfo, explainSuggestion, rankSuggestions } from './relevance';
import { appearanceOrder, fitSphere, Sphere } from './sphere';
import {
	AnimationSetup,
	framesShape,
	hasSignals,
	IDLE_CHOICES,
	IdleAnimation,
	IdleChoice,
	isIdleChoice,
	randomAnimation,
	keepsEdges,
	placeWork,
	setUpAnimation,
	signals,
} from './animations';
import { colorOfPlace, colorsFromSharedKeywords, mainTopics, topicName, WorkTopics } from './topics';
import { ballCenters, fingerprint, fitPlane, groupNames, groupTargets, titleTerms, meaningBasis, MeaningBasis, meaningGroups, MeaningGroups, nearestInPlane, placeIn, Plane, project, tokenize, vectorize, Vocabulary, vocabularyOf } from './meaning';
import type { MeaningCache } from './meaningCache';
import { keywordsInNote, keywordsProperty } from './keywordNotes';
import { WorkSuggest } from './workSuggest';
import { WORK_VIEW, WorkState } from './workView';
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
	/** Color of its topics (coloring by topic), before it is darkened for works outside the vault. */
	topicColor: number | null;
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
	/** Works outside the vault (depth 1), and those of depth 2. */
	outside: ThemeColor;
	outside2: ThemeColor;
	focused: ThemeColor;
	/** Arrows of the works citing the hovered work. */
	incoming: ThemeColor;
	line: ThemeColor;
	text: ThemeColor;
	background: ThemeColor;
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

/** The node limit of the settings: 0 (or empty) means no limit; otherwise at least 100. */
function maxNodesOf(setting: unknown): number {
	const value = Number(setting);
	if (!Number.isFinite(value)) return 3000;
	return value <= 0 ? Infinity : Math.max(100, value);
}

/** Starting zoom of the local graph. */
const LOCAL_START_SCALE = 1.5;
/**
 * The opening animation from saved positions: works start a little closer to
 * the middle and shaken by up to this many units, and the layout brings them
 * back from this alpha (about 2 to 4 s).
 */
const OPENING_SHRINK = 0.9;
const OPENING_SHAKE = 40;
const OPENING_ALPHA = 0.3;
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
/** Reading suggestions shown at first, and added by "Show more". */
const SUGGESTIONS_PAGE = 100;
/** Zoom at least to this scale when going to a work found by the search field. */
const SEARCH_SCALE = 1.2;
/** Idle animation: seconds to fold the graph onto the sphere, and to unfold it. */
const IDLE_FOLD_SECONDS = 1.5;
const IDLE_UNFOLD_SECONDS = 0.4;
/** Seconds for every work to appear, one by one, on the sphere. */
const APPEAR_SECONDS = 25;
/** The speed setting at which the idle animations run at their own pace. */
const NORMAL_SPEED = 5;
/** Signals running along the citations in the constellation, and their radius on screen (pixels). */
const SIGNALS = 40;
const SIGNAL_RADIUS = 3;
/** Works outside the vault colored by topic: darker than the vault's, but less than usual, to keep their hue. */
const TOPIC_OUTSIDE_BLEND = 0.35;
/** A year of publication that makes sense (the layouts ignore the others), or null. */
const plausibleYear = (year: number | null | undefined): number | null =>
	year !== null && year !== undefined && year > 1000 && year < 3000 ? year : null;
/** Characters of a note read for its vector of meaning (the longest books are cut). */
const MEANING_TEXT_LIMIT = 200_000;
/** Dimensions of the vectors of meaning. */
const MEANING_DIMENSIONS = 64;
/** How many works nearest in meaning each work is drawn to, in the Meaning layout. */
const MEANING_NEIGHBORS = 6;
/** At most this many groups (balls) of meaning in the Meaning layout. */
const MEANING_MAX_GROUPS = 24;
/** How visible the citation lines stay in the Meaning layout (1: as usual). */
const MEANING_EDGE_FADE = 0.2;
/** Topics listed in the panel's legend when coloring by topic. */
const TOPIC_LEGEND = 12;
/** Share of the view the sphere fills. */
const SPHERE_FILL = 0.8;
/** Alpha of the works at the back of the sphere. */
const BACK_ALPHA = 0.25;
/** How far the neighbors of a highlighted work take the color of their arrows. */
const NEIGHBOR_TINT = 0.75;
/** Milliseconds per year when the timeline plays. */
const TIMELINE_YEAR_MS = 300;
/** Share of the way the hover highlight moves at each frame (a fade of about 150 ms). */
const FOCUS_FADE_STEP = 0.3;
/** Share of the way the camera and the wheel zoom move at each frame. */
const CAMERA_STEP = 0.14;
const ZOOM_STEP = 0.3;
/** How far the color of works outside the vault goes toward the background (0: the notes' color, 1: the background). */
const OUTSIDE_BLEND = 0.5;
/** And those of depth 2, further from depth 1's color. */
const DEPTH_2_BLEND = 0.3;
/** Alpha of the edges that do not touch the hovered node. */
const DIMMED_EDGE_ALPHA = 0.08;
/** Width of lines on screen (pixels), and of the hovered work's arrows. */
const EDGE_WIDTH = 0.6;
const FOCUS_EDGE_WIDTH = 1.5;
/** Lines fade from full at this zoom (and closer) to EDGE_FADE_MIN of their alpha at EDGE_FADE_FROM (and farther). */
const EDGE_FADE_TO = 1;
const EDGE_FADE_FROM = 0.15;
const EDGE_FADE_MIN = 0.3;
/** Arrowhead size, in pixels on screen; arrowheads are hidden when zoomed out past this scale. */
const ARROW_SIZE = 4;
const ARROW_MIN_SCALE = 0.5;

function radiusOf(node: GraphNode): number {
	// (Doubled on 2026-09-30, at the user's request: the works are seen better from far.)
	const r = node.depth === 0 ? 8 + Math.sqrt(node.citedBy) * 4.4 : 4 + Math.sqrt(node.citedBy) * 2.4;
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

	/** Moves the edges to their nodes' current positions; `hidden` edges are drawn as nothing. */
	update(width: number, arrow: number, hidden?: (link: SimLink) => boolean): void {
		if (this.links.length === 0) return;
		const out = this.positions;
		const ends = { x1: 0, y1: 0, x2: 0, y2: 0, targetRadius: 0 };
		this.links.forEach((link, i) => {
			ends.x1 = link.source.x ?? 0;
			ends.y1 = link.source.y ?? 0;
			const hide = hidden?.(link) === true;
			ends.x2 = hide ? ends.x1 : (link.target.x ?? 0);
			ends.y2 = hide ? ends.y1 : (link.target.y ?? 0);
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
 * the vault that they cite (depth 1) and that those cite (depth 2),
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
	/** Arrows of the hovered work: to the works it cites, and from the works citing it. */
	private readonly focusOutEdges = new EdgeMesh();
	private readonly focusInEdges = new EdgeMesh();
	private readonly nodesLayer = new Container();
	/** Chronological layout: the decades above the graph, and faint lines down through it. */
	private readonly axisLayer = new Container();
	/** The regions of the Meaning layout: a circle and a name around each group of meaning (behind the works). */
	private readonly regionLayer = new Container();
	/** The group of meaning of each work (by node index) and each group's circle and name; see `buildRegions`. */
	private regions: { group: number[]; parts: { circle: Graphics; label: Text; color: number }[] } | null = null;
	/** When the regions were last fitted to the works (they follow them a few times a second at most). */
	private regionsPlacedAt = 0;
	private axisParts: { top: Container; grid: Graphics; margin: number } | null = null;
	/** Bright signals running along the citations (the constellation animation). */
	private readonly signalsLayer = new Container();
	private signalSprites: Sprite[] = [];
	/** Coloring by topic: the main topics of the graph (legend), and the graph whose topics were fetched. */
	private topicLegend: { name: string; works: number; color: number }[] = [];
	private topicLegendEl: HTMLElement | null = null;
	private groupsEl: HTMLElement | null = null;
	/** The places of the works in the plane of meaning (by work id), for the graph they were computed for. */
	private meaningById = new Map<string, [number, number]>();
	/** The works nearest in meaning to each work (by node index, with their similarity), for the Meaning layout. */
	private meaningKin: [number, number][][] = [];
	/** What meaning is learned from: the literature notes of the vault (see `meaningModel`). */
	private meaningModelCache: { key: string; vocabulary: Vocabulary; basis: MeaningBasis; plane: Plane | null } | null = null;
	/** The works (their ids) whose meaning was last computed: a graph shown again with the same works is not computed again. */
	private meaningFor: string | null = null;
	private meaningRun = 0;
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
	/** Neighbors of the highlighted node: the works it cites, and the works citing it (colored like their arrows). */
	private focusCited = new Set<SimNode>();
	private focusCiting = new Set<SimNode>();
	private dragged: SimNode | null = null;
	private dragMoved = false;
	private dragStart = { x: 0, y: 0 };
	private panning: { x: number; y: number } | null = null;
	/** Wheel zoom in progress: the zoom to reach, and the point that stays under the pointer. */
	private zoom: { scale: number; px: number; py: number; wx: number; wy: number } | null = null;
	/**
	 * Where the camera goes by itself: fit the whole graph, center the local
	 * note, follow the work found by the search field, or nowhere (moved by the user).
	 */
	private cameraMode: 'fit' | 'center' | 'work' | null = 'fit';
	/** The work found with the search field, which the camera goes to. */
	private searchTarget: SimNode | null = null;
	/**
	 * The idle animation (see `sphere.ts`): `level` goes from 0 (flat graph)
	 * to 1 (sphere) and back; `rank` and `anchor` (by node index) say when
	 * each work appears, and out of which work it grows.
	 */
	private idle = {
		running: false,
		level: 0,
		startedAt: 0,
		lastFrame: 0,
		sphere: null as Sphere | null,
		/** The animation playing, and what it needs about the works. */
		animation: 'sphere' as IdleAnimation,
		/** Zoom chosen with the wheel while it plays (1: the shape fills the view). */
		zoom: 1,
		/** Where each work is drawn (x, y by index), for hovering while it plays. */
		shown: new Float64Array(0),
		setup: null as AnimationSetup | null,
		rank: [] as number[],
		anchor: [] as (SimNode | null)[],
		appear: [] as number[],
		/** How far in front each work is drawn (1: in front, 0: at the back), and its size from the perspective. */
		front: [] as number[],
		perspectiveScale: [] as number[],
		/** The camera before the animation, to go back to. */
		returnTo: null as Camera | null,
		/** Started from the panel's button: input is ignored until then, so that the click does not stop it. */
		graceUntil: 0,
	};
	/** When the user last touched Obsidian (mouse or keyboard). */
	private lastActivity = Date.now();
	/**
	 * Timeline: only the works published up to this year are shown (null: all).
	 * Works whose year is unknown are always shown.
	 */
	private yearLimit: number | null = null;
	/** Year of publication of each node, by index. */
	private years: (number | null)[] = [];
	private yearSlider: SliderComponent | null = null;
	/** True while the code moves the year slider: its change is not the user's. */
	private movingYearSlider = false;
	private timelineDesc: HTMLElement | null = null;
	private timelineTimer: number | null = null;
	private frameId: number | null = null;
	private frameWindow: Window | null = null;
	/** Whether frames stopped because the view was hidden; they resume when it shows again. */
	private paused = false;
	/** The edges must be rebuilt at the next frame. */
	private edgesDirty = true;
	private lastEdgeScale = 0;
	private statusEl: HTMLElement | null = null;
	private controlsEl: HTMLElement | null = null;
	/** The message shown when there is nothing to show. */
	private emptyEl: HTMLElement | null = null;
	/** The column of buttons along the right edge, and the display panel. */
	private toolbarEl: HTMLElement | null = null;
	private displayEl: HTMLElement | null = null;
	private hintEl: HTMLElement | null = null;
	/** The list of reading suggestions (works outside the vault, most relevant first), when open. */
	private suggestionsEl: HTMLElement | null = null;
	/** How many suggestions the list shows; "Show more" adds SUGGESTIONS_PAGE. */
	private suggestionsShown = SUGGESTIONS_PAGE;
	/** The list shows all works outside the vault, or only those OpenAlex does not know. */
	private suggestionsMissing = false;
	/** The graph shown now (the local part of it, in local mode). */
	private shownGraph: LiteratureGraph | null = null;
	private summary = '';
	/** Options of this view; start from the settings, changed only for this view. */
	options: GraphOptions;
	private loading = 0;
	/** Local mode: only the works around the active note, up to `localDepth` citations away. */
	private local = false;
	private localDepth = 1;
	/** Style of layout, from the settings, changed in the panel for as long as the view is open. */
	private layoutStyle: LayoutStyle = 'default';
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
	private forces: Forces = { repel: 90, linkDistance: 60, center: 0.02, meaning: 1 };
	private readonly reload = debounce(() => void this.loadData(), 2000, true);

	constructor(
		leaf: WorkspaceLeaf,
		private readonly index: CitationIndex,
		private readonly openAlex: OpenAlexClient,
		private readonly settings: () => LiteratureGraphSettings,
		/** Saves settings changed in the view (color groups, idle animation) and updates every graph view. */
		private readonly saveSettings: (changes: Partial<LiteratureGraphSettings>) => Promise<void>,
		/** Where the works were when the layout last came to rest. */
		private readonly positions: PositionStore,
		/** What was written in the ghost notes of the works outside the vault. */
		private readonly ghosts: GhostNoteStore,
		/** The places of the works in the plane of meaning, kept between openings. */
		private readonly meaningCache: MeaningCache,
	) {
		super(leaf);
		const s = settings();
		// The dropdown setting stores a string.
		this.options = {
			depth: Number(s.graphDepth) || 0,
			minCitations: Math.max(1, Number(s.graphMinCitations) || 1),
			maxNodes: maxNodesOf(s.graphMaxNodes),
			localWorks: true,
			allNotes: s.graphAllNotes === true,
			edgeSources: {
				link: s.graphEdgeLinks !== false,
				bibliography: s.graphEdgeBibliographies !== false,
				openalex: s.graphEdgeOpenAlex !== false,
			},
		};
		this.layoutStyle = isLayoutStyle(s.graphLayout) ? s.graphLayout : 'default';
		const number = (value: unknown, fallback: number) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
		this.forces = {
			repel: number(s.graphRepel, 90),
			linkDistance: number(s.graphLinkDistance, 60),
			center: number(s.graphCenter, 0.02),
			meaning: number(s.graphMeaningAttraction, 1),
		};
	}

	getViewType(): string {
		return GRAPH_VIEW;
	}

	getDisplayText(): string {
		return this.local ? 'Local literature graph' : 'Literature graph';
	}

	getState(): Record<string, unknown> {
		return { local: this.local, depth: this.localDepth, direction: this.direction };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as { local?: boolean; depth?: number; direction?: string };
		const wasLocal = this.local;
		this.local = s.local === true;
		this.localDepth = Math.min(3, Math.max(1, Number(s.depth) || 1));
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
		this.emptyEl = container.createDiv({ cls: 'literature-graph-empty is-hidden' });
		this.hintEl = container.createDiv({ cls: 'literature-graph-view-hint is-hidden' });
		this.buildSearch(container);
		this.buildSuggestions(container);
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
			this.axisLayer,
			this.regionLayer,
			this.outsideEdges.mesh,
			this.vaultEdges.mesh,
			this.focusInEdges.mesh,
			this.focusOutEdges.mesh,
			this.signalsLayer,
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
		// Keywords edited in a note, or a ghost note edited: colors again, and the Meaning layout places its works again.
		const topicsEdited = debounce(
			() => {
				if (!this.byMeaning() && this.layoutStyle !== 'meaning') return;
				this.meaningFor = null;
				this.applyColorGroups();
			},
			1000,
			true,
		);
		this.register(this.ghosts.onChange(() => topicsEdited()));
		// (Only when the keywords themselves changed: typing in a note does nothing.)
		const seenTopics = new Map<string, string>();
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (!this.nodes.some((n) => n.data.file === file)) return;
				const topics = keywordsInNote(this.app, file, keywordsProperty(this.settings())).join('\n');
				const before = seenTopics.get(file.path);
				seenTopics.set(file.path, topics);
				// (First time a note is seen: only if it has topics, which may be new.)
				if (before !== topics && (before !== undefined || topics !== '')) topicsEdited();
			}),
		);
		this.registerEvent(this.app.workspace.on('file-open', () => this.followActiveNote()));
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.followActiveNote();
				this.resume();
			}),
		);
		this.registerEvent(this.app.workspace.on('layout-change', () => this.resume()));
		this.watchActivity();
		await Promise.all([this.positions.load(), this.ghosts.load()]);
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
		// A computation of meaning still running stops at its next step.
		this.meaningRun++;
		this.layout?.destroy();
		this.layout = null;
		if (this.frameId !== null) this.frameWindow?.cancelAnimationFrame(this.frameId);
		this.frameId = null;
		this.pixi?.destroy(true, { children: true });
		this.pixi = null;
	}

	/**
	 * Reads the colors of the theme (Obsidian's graph variables), and those of
	 * the settings. Works outside the vault are the notes' color blended with
	 * the background (darker on a dark theme, paler on a light one), so the
	 * works you have stand out; the settings may give other colors.
	 */
	private readTheme(): void {
		const style = getComputedStyle(this.contentEl.doc.body);
		const v = (name: string) => style.getPropertyValue(name);
		const s = this.settings();
		const node = parseCssColor(v('--graph-node'), '#999999');
		const background = parseCssColor(v('--background-primary'), '#202020');
		const outside = s.graphOutsideColor.trim()
			? parseCssColor(s.graphOutsideColor, '#666666')
			: { color: mixColor(node.color, background.color, OUTSIDE_BLEND), alpha: node.alpha };
		this.theme = {
			node,
			outside,
			outside2: { color: mixColor(outside.color, background.color, DEPTH_2_BLEND), alpha: outside.alpha },
			focused: parseCssColor(v('--graph-node-focused'), '#7f6df2'),
			incoming: parseCssColor(s.graphIncomingColor.trim() || v('--color-orange'), '#e0913a'),
			line: parseCssColor(v('--graph-line'), '#555555'),
			text: parseCssColor(v('--graph-text'), '#dddddd'),
			background,
			fontFamily: v('--font-interface') || 'sans-serif',
		};
		for (const node of this.nodes) {
			if (!node.label) continue;
			node.label.style.fill = this.theme.text.color;
			node.label.style.fontFamily = this.theme.fontFamily;
		}
	}

	/**
	 * A message in the middle of the view when there is nothing to show, and
	 * why: no literature notes where the settings look for them, or a local
	 * graph around a note that no citation links to any work.
	 */
	private showEmptyState(vaultWorks: number): void {
		const el = this.emptyEl;
		if (!el) return;
		el.empty();
		let message: string | null = null;
		if (!this.local && vaultWorks === 0) {
			const folder = this.settings().literatureFolder.trim();
			message = folder
				? `No literature notes in the folder “${folder}”. Set the folder of your literature notes in the plugin settings (Literature folder).`
				: 'No literature notes found. Set the folder of your literature notes in the plugin settings (Literature folder).';
			el.createDiv({ cls: 'literature-graph-empty-text', text: message });
			const button = el.createEl('button', { text: 'Open settings' });
			button.addEventListener('click', () => {
				const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
				setting?.open();
				setting?.openTabById('literature-graph');
			});
		} else if (this.local && this.nodes.length <= 1) {
			const name = this.center ? (this.center.split('/').pop() ?? this.center).replace(/\.md$/, '') : null;
			message = name
				? `No citations around “${name}” yet: no citation link, reference list or OpenAlex reference connects it to another work.`
				: 'Open a note to see the works around it.';
			el.createDiv({ cls: 'literature-graph-empty-text', text: message });
		}
		el.toggleClass('is-hidden', message === null);
	}

	private setStatus(message: string): void {
		this.statusEl?.setText(message);
	}

	/** Builds the graph, depth by depth, and shows each stage. */
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
	 * The works at most `localDepth` citations away from the center, following
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
				depth: 0,
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
						depth: 1,
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
		for (let d = 0; d < this.localDepth; d++) {
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
				topicColor: null,
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
		// Works not shown yet start where they were when the layout last came to
		// rest (global graph), a little shaken: the graph keeps its shape, and
		// its points move for a moment as it opens, as in Obsidian's graph view.
		const saved = this.local ? {} : this.positions.get(this.layoutStyle);
		let fromSaved = 0;
		for (const node of this.nodes) {
			const at = node.x === undefined ? saved[node.data.id] : undefined;
			if (!at) continue;
			node.x = at[0] * OPENING_SHRINK + (Math.random() - 0.5) * OPENING_SHAKE;
			node.y = at[1] * OPENING_SHRINK + (Math.random() - 0.5) * OPENING_SHAKE;
			fromSaved++;
		}
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
		this.searchTarget = this.searchTarget ? (byId.get(this.searchTarget.data.id) ?? null) : null;
		this.shownFocus = this.shownFocus ? (byId.get(this.shownFocus.data.id) ?? null) : null;
		this.dragged = null;
		if (!this.shownFocus) this.focusLevel = 0;

		const outside = (l: SimLink) => l.source.data.depth > 0 || l.target.data.depth > 0;
		this.vaultEdges.setLinks(this.links.filter((l) => !outside(l)));
		this.outsideEdges.setLinks(this.links.filter(outside));
		this.updateFocusEdges();

		this.applyColorGroups();
		if (this.local && this.nodes.length <= MAX_FILTER_LABELS) for (const node of this.nodes) this.ensureLabel(node);
		// Labels of the vault's works; others get one on hover.
		for (const node of this.nodes) if (node.data.depth === 0) this.ensureLabel(node);
		this.labelMatches();

		// Years first: the chronological and circle layouts place the works by them.
		this.readYears();
		this.buildTimeAxis();
		const meaning = this.layoutStyle === 'meaning';
		const anchors = meaning ? this.meaningAnchors() : null;
		// (The kin found for these same nodes, if the meaning is known.)
		const kin = meaning && this.meaningKin.length === this.nodes.length ? this.meaningKin : null;
		this.layout?.send({
			type: 'start',
			graph: ++this.layoutGraph,
			nodes: this.nodes.map((n) => ({ x: n.x, y: n.y, depth: n.data.depth, radius: n.radius * this.pointSize(), year: plausibleYear(this.years[n.index]), anchor: anchors?.[n.index] ?? null, kin: kin?.[n.index] ?? null })),
			links: this.links.map((l) => ({ source: l.source.index, target: l.target.index, inVault: !outside(l) })),
			forces: this.forces,
			// From saved places, a short settling (about 2 to 4 s) is enough.
			alpha: previous.size > 0 ? 0.5 : fromSaved > this.nodes.length / 2 ? OPENING_ALPHA : 1,
			style: this.layoutStyle,
		});

		const counts = [0, 0, 0];
		for (const n of this.nodes) counts[n.data.depth] = (counts[n.data.depth] ?? 0) + 1;
		const parts = [`${counts[0]} works of the vault`];
		if ((counts[1] ?? 0) > 0) parts.push(`${counts[1]} cited works outside it`);
		if ((counts[2] ?? 0) > 0) parts.push(`${counts[2]} at depth 2`);
		parts.push(`${this.links.length} citations`);
		if (graph.leftOut > 0) parts.push(`${graph.leftOut} works left out (node limit)`);
		this.summary = parts.join(' · ');
		this.setStatus(this.summary);
		this.showEmptyState(counts[0] ?? 0);
		this.shownGraph = graph;
		this.renderSuggestions();
		this.invalidate();
	}

	/** The settings changed: colors of the theme and of the settings, and color groups. */
	applySettings(): void {
		this.readTheme();
		this.applyColorGroups();
	}

	/** Coloring by meaning (see `meaning.ts`) rather than by color groups. */
	private byMeaning(): boolean {
		return this.settings().graphColorBy === 'meaning';
	}

	/** Lightness of the topic colors: light on a dark theme, deeper on a light one. */
	private topicLightness(): number {
		return this.contentEl.doc.body.hasClass('theme-dark') ? 0.62 : 0.45;
	}

	/**
	 * Gives each work the color of its topics on OpenAlex. Works of the vault
	 * that OpenAlex does not know take the colors of the notes sharing their
	 * links (their keywords); works outside the vault without topics keep the
	 * usual color. Topics missing from the cache are fetched once, then the
	 * graph is colored again.
	 */
	/** A work's topics on OpenAlex. */
	private workTopics(node: SimNode): WorkTopics | undefined {
		return node.data.openAlexId ? this.openAlex.cachedWork(node.data.openAlexId)?.topics : undefined;
	}

	/** Words of the notes of the vault, and their fingerprint, kept while a note does not change (reading a long note costs). */
	private readonly noteWords = new Map<string, { mtime: number; words: string[]; text: string }>();

	/** What OpenAlex says of a work: its title, topics, keywords and abstract (from the cache). */
	private openAlexText(id: string, title = ''): string {
		const work = this.openAlex.cachedWork(id);
		const topics = (work?.topics ?? []).map(([topic]) => this.openAlex.topicInfo(topic)?.name ?? '');
		const keywords = (work?.keywords ?? []).map(([keyword]) => keyword);
		return [work?.title ?? title, ...topics, ...keywords, this.openAlex.cachedAbstract(id) ?? ''].join('\n');
	}

	/**
	 * The OpenAlex ids of the works the literature notes of the vault cite
	 * (from the cache, sorted), which are not notes of the vault themselves.
	 */
	private citedByVault(files: TFile[]): string[] {
		const own = new Set<string>();
		const cited = new Set<string>();
		for (const file of files) {
			const doi = this.index.doiForFile(file);
			const id = doi ? this.openAlex.cachedIdForDoi(doi) : null;
			if (!id) continue;
			own.add(id);
			for (const ref of this.openAlex.cachedWork(id)?.references ?? []) cited.add(ref);
		}
		return [...cited].filter((id) => !own.has(id) && this.openAlex.cachedWork(id)).sort();
	}

	/** The words of a note of the vault (its title, keywords and whole text, without its other properties), and their fingerprint. */
	private async noteText(file: TFile): Promise<{ words: string[]; text: string }> {
		const cached = this.noteWords.get(file.path);
		if (cached && cached.mtime === file.stat.mtime) return cached;
		const text = (await this.app.vault.cachedRead(file)).slice(0, MEANING_TEXT_LIMIT);
		const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
		const keywords = keywordsInNote(this.app, file, keywordsProperty(this.settings()));
		const words = tokenize([this.index.vaultWork(file)?.title || file.basename, ...keywords, body].join('\n'));
		const entry = { mtime: file.stat.mtime, words, text: fingerprint(words.join(' ')) };
		this.noteWords.set(file.path, entry);
		return entry;
	}

	/**
	 * What meaning is learned from: the vocabulary, the main directions and
	 * the plane of the colors, all from the literature notes of the vault and
	 * the works they cite (their texts from OpenAlex, without the ghost
	 * notes), in a fixed order, whatever the graph shows. So a work keeps its
	 * meaning, and its color, from one opening of the graph to the next, and
	 * in every graph; it changes only when the text of the notes of the vault
	 * changes (or they cite new works). Learned only when a work's place is
	 * not in the cache (see `meaningCache.ts`).
	 */
	private async meaningModel(
		files: TFile[],
		cited: string[],
		key: string,
		pause: () => Promise<void>,
	): Promise<{ vocabulary: Vocabulary; basis: MeaningBasis; plane: Plane | null }> {
		if (this.meaningModelCache?.key === key) return this.meaningModelCache;
		const words: string[][] = [];
		for (const file of files) words.push((await this.noteText(file)).words);
		for (let i = 0; i < cited.length; i++) {
			words.push(tokenize(this.openAlexText(cited[i] ?? '')));
			if (i % 500 === 499) await pause();
		}
		const vocabulary = vocabularyOf(words);
		await pause();
		const vectors = words.map((w) => vectorize(w, vocabulary));
		await pause();
		const basis = await meaningBasis(vectors, vocabulary.idf.length, MEANING_DIMENSIONS, pause);
		const plane = fitPlane(vectors.map((v) => project(v, basis)));
		this.meaningModelCache = { key, vocabulary, basis, plane };
		return this.meaningModelCache;
	}

	/**
	 * The text of a work for its meaning, as a fingerprint (to know whether its
	 * cached place still holds) and as words (read only if needed): its whole
	 * note; or what OpenAlex says of it; or its reference. What was written in
	 * the ghost note of a work outside the vault counts too.
	 */
	private async workText(node: SimNode): Promise<{ text: string; words: () => string[] }> {
		const file = node.data.file;
		if (file) {
			const note = await this.noteText(file);
			return { text: note.text, words: () => note.words };
		}
		const id = node.data.openAlexId;
		const ghost = id ? this.ghosts.get({ id, doi: node.data.doi }) : this.ghosts.get({ doi: node.data.doi, entry: node.data.entry });
		const text = id
			? `${this.openAlexText(id, node.data.title)}\n${ghost ?? ''}`
			: `${node.data.title} ${node.data.entry?.text ?? ''} ${ghost ?? ''}`;
		return { text: fingerprint(text), words: () => tokenize(text) };
	}

	/**
	 * Gives the works shown their places in the plane of meaning, once per set
	 * of works: from the cache (`meaningCache.ts`) when their text and the
	 * notes of the vault are the same as when it was computed, otherwise by
	 * computing them (fetching first, once, the keywords and abstracts OpenAlex
	 * has for the works outside the vault). Then colors the works and, in the
	 * Meaning layout, finds each work's nearest works in the plane and places
	 * them. The long loops pause now and then, so Obsidian stays responsive.
	 */
	private async computeMeaning(): Promise<void> {
		const graph = this.shownGraph;
		if (!graph) return;
		const needKin = this.layoutStyle === 'meaning';
		// By the works shown, not by the graph object: showing the same works
		// again (the Meaning layout does, once the meaning is known) builds a
		// new object, and must not start the computation again.
		const works = `${this.nodes.map((n) => n.data.id).join('\n')}\n${needKin ? 'kin' : ''}`;
		if (this.meaningFor === works) return;
		this.meaningFor = works;
		const run = ++this.meaningRun;
		const nodes = this.nodes.slice();
		// A message, not a timer: timers are slowed down to once a second or
		// less while Obsidian's window is in the background.
		const pause = () =>
			new Promise<void>((resolve) => {
				const channel = new MessageChannel();
				channel.port1.onmessage = () => {
					channel.port1.close();
					resolve();
				};
				channel.port2.postMessage(null);
			});
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => this.index.isLiterature(f))
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		const cited = this.citedByVault(files);
		const ids = [...new Set([...nodes.flatMap((n) => (n.data.openAlexId ? [n.data.openAlexId] : [])), ...cited])];
		try {
			await this.openAlex.loadExtras(
				ids,
				(done, total) => this.setStatus(`${this.summary} · Loading the keywords and abstracts of the works: ${done} of ${total}…`),
				{ abstracts: true },
			);
		} catch (error) {
			console.error('Literature Graph: OpenAlex request failed', error);
		}
		if (run !== this.meaningRun) return;
		this.setStatus(`${this.summary} · Computing the meaning of the works…`);
		await this.meaningCache.load();
		// What the meaning is learned from, as one fingerprint.
		const sources: string[] = [];
		for (const file of files) {
			sources.push(`${file.path}\t${(await this.noteText(file)).text}`);
			await pause();
		}
		for (const id of cited) sources.push(`${id}\t${fingerprint(this.openAlexText(id))}`);
		sources.push(keywordsProperty(this.settings()));
		const model = fingerprint(sources.join('\n'));
		if (run !== this.meaningRun) return;
		this.meaningCache.useModel(model);
		// Places from the cache; the others are computed.
		const places = new Map<string, [number, number]>();
		const missing: { node: SimNode; text: string; words: () => string[] }[] = [];
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			if (!node) continue;
			const { text, words } = await this.workText(node);
			const place = this.meaningCache.place(node.data.id, text);
			if (place === undefined) missing.push({ node, text, words });
			else if (place) places.set(node.data.id, place);
			if (i % 500 === 499) await pause();
		}
		if (run !== this.meaningRun) return;
		if (missing.length > 0) {
			const { vocabulary, basis, plane } = await this.meaningModel(files, cited, model, pause);
			for (let i = 0; i < missing.length; i++) {
				const { node, text, words } = missing[i] ?? { node: null, text: '', words: () => [] };
				if (!node) continue;
				const vector = project(vectorize(words(), vocabulary), basis);
				const place = vector && plane ? placeIn(plane, vector) : null;
				this.meaningCache.setPlace(node.data.id, text, place);
				if (place) places.set(node.data.id, place);
				if (i % 200 === 199) await pause();
			}
			if (run !== this.meaningRun) return;
		}
		this.meaningById = places;
		// The Meaning layout draws each work to its nearest works in the plane (by node index).
		this.meaningKin = needKin ? nearestInPlane(nodes.map((n) => places.get(n.data.id) ?? null), MEANING_NEIGHBORS) : [];
		this.setStatus(this.summary);
		this.applyTopicColors();
		// The Meaning layout places the works by their meaning, now known.
		if (this.layoutStyle === 'meaning') this.showCurrent();
	}

	/**
	 * Where each work is drawn to in the Meaning layout: the works are grouped
	 * by meaning (so by color, in the plane of meaning), each group gets a ball
	 * as large as its works need, near the balls of neighbor colors, and each
	 * work goes to its group's ball, or between the balls of its two nearest
	 * groups as much as it resembles each (see `meaning.ts`). The "Meaning
	 * attraction" setting makes the groups more decided.
	 */
	private meaningAnchors(): ([number, number] | null)[] {
		const places = this.nodes.map((n) => this.meaningById.get(n.data.id) ?? null);
		const placed = places.filter(Boolean).length;
		const groups = meaningGroups(places, Math.max(3, Math.min(MEANING_MAX_GROUPS, Math.round(Math.sqrt(placed) / 6))));
		// Room for one work in a ball: a little more than its collision disc.
		const radius = this.nodes.reduce((s, n) => s + n.radius * this.pointSize(), 0) / Math.max(1, this.nodes.length);
		const balls = ballCenters(groups, (radius * 1.25 + 1) * 1.6);
		this.buildRegions(groups, balls.radii);
		return groupTargets(places, groups, balls.centers, this.forces.meaning);
	}

	/** The keywords of a work: its keywords property for a note of the vault, else its keywords on OpenAlex (cached). */
	private workKeywords(node: SimNode): string[] {
		const file = node.data.file;
		if (file) {
			const own = keywordsInNote(this.app, file, keywordsProperty(this.settings()));
			if (own.length > 0) return own;
		}
		const id = node.data.openAlexId ?? (node.data.doi ? this.openAlex.cachedIdForDoi(node.data.doi) : null);
		return id ? (this.openAlex.cachedWork(id)?.keywords ?? []).map(([name]) => name) : [];
	}

	/** The color of a place in the plane of meaning, with the brightness and intensity of the settings. */
	private placeColor(place: [number, number]): number {
		const s = this.settings();
		const lightness = Math.min(0.9, Math.max(0.15, this.topicLightness() + (Number(s.graphTopicBrightness) || 0) / 100));
		const intensity = Math.max(0.1, (Number(s.graphTopicIntensity) || 100) / 100);
		return colorOfPlace(place, lightness, intensity);
	}

	/**
	 * The regions of the Meaning layout: for each group of meaning, a circle
	 * of the group's color and its name, the keyword most typical of its works
	 * (see `groupNames`), or else its most frequent OpenAlex topic. The names
	 * are drawn in world units, so they grow and shrink with the zoom.
	 */
	private buildRegions(groups: MeaningGroups, radii: number[]): void {
		const layer = this.regionLayer;
		for (const child of layer.removeChildren()) child.destroy({ children: true });
		this.regions = null;
		const theme = this.theme;
		if (!theme) return;
		const count = groups.centers.length;
		// Terms of each work: its keywords, and the words of its title.
		const terms = this.nodes.map((n) => {
			const id = n.data.openAlexId;
			const title = (id ? this.openAlex.cachedWork(id)?.title : null) ?? n.data.title;
			return [...this.workKeywords(n), ...titleTerms(title)];
		});
		const names = groupNames(terms, groups.group, count);
		const info = (id: string) => this.openAlex.topicInfo(id);
		const parts = groups.centers.map((center, g) => {
			let name = names[g] ?? null;
			if (!name) {
				const topics = this.nodes.flatMap((n, i) => (groups.group[i] === g ? [this.workTopics(n)] : []));
				const top = mainTopics(topics, 1)[0];
				name = top ? topicName(top.id, info) : '';
			}
			const color = this.placeColor(center);
			const circle = new Graphics();
			const fontSize = Math.max(36, (radii[g] ?? 100) * 0.22);
			const label = new Text({ text: name, style: { fontSize, fontWeight: '600', fill: color, fontFamily: theme.fontFamily } });
			label.anchor.set(0.5, 1);
			layer.addChild(circle, label);
			return { circle, label, color };
		});
		this.regions = { group: groups.group, parts };
		this.regionsPlacedAt = 0;
	}

	/**
	 * Fits each region to its works where they are now: centered on them, and
	 * wide enough for nine in ten of them (a few strays do not widen it). At
	 * most four times a second; returns whether to come back (the works move).
	 */
	private placeRegions(now: number): boolean {
		const regions = this.regions;
		const shown = !!regions && this.layoutStyle === 'meaning' && this.settings().graphShowRegions === true;
		this.regionLayer.visible = shown;
		if (!shown || !regions) return false;
		// Hidden during the idle animation, where the works are elsewhere for a while.
		this.regionLayer.alpha = 1 - this.idle.level;
		if (this.idle.level > 0) return false;
		if (now - this.regionsPlacedAt < 250) return this.regionsPlacedAt > 0;
		this.regionsPlacedAt = now;
		const count = regions.parts.length;
		const sums = Array.from({ length: count }, () => [0, 0, 0]);
		this.nodes.forEach((n, i) => {
			const s = sums[regions.group[i] ?? -1];
			if (!s || n.x === undefined || n.y === undefined) return;
			s[0] = (s[0] ?? 0) + n.x;
			s[1] = (s[1] ?? 0) + n.y;
			s[2] = (s[2] ?? 0) + 1;
		});
		const distances: number[][] = Array.from({ length: count }, () => []);
		this.nodes.forEach((n, i) => {
			const g = regions.group[i] ?? -1;
			const s = sums[g];
			if (!s || !s[2] || n.x === undefined || n.y === undefined) return;
			distances[g]?.push(Math.hypot(n.x - (s[0] ?? 0) / s[2], n.y - (s[1] ?? 0) / s[2]));
		});
		regions.parts.forEach(({ circle, label, color }, g) => {
			const s = sums[g] ?? [0, 0, 0];
			const d = (distances[g] ?? []).sort((a, b) => a - b);
			circle.clear();
			label.visible = d.length > 0;
			if (d.length === 0) return;
			const cx = (s[0] ?? 0) / (s[2] || 1);
			const cy = (s[1] ?? 0) / (s[2] || 1);
			const r = (d[Math.floor(d.length * 0.9)] ?? d[d.length - 1] ?? 0) + label.style.fontSize * 0.3;
			circle.circle(cx, cy, r).fill({ color, alpha: 0.05 }).stroke({ width: Math.max(2, r / 120), color, alpha: 0.45 });
			label.position.set(cx, cy - r - label.style.fontSize * 0.15);
		});
		return true;
	}

	private applyTopicColors(): void {
		// Meaning serves the colors and the Meaning layout.
		if (!this.byMeaning() && this.layoutStyle !== 'meaning') {
			for (const node of this.nodes) node.topicColor = null;
			this.topicLegend = [];
			this.renderTopicLegend();
			return;
		}
		// (After the graph is set as shown.)
		void Promise.resolve().then(() => this.computeMeaning());
		if (!this.byMeaning()) {
			for (const node of this.nodes) node.topicColor = null;
			this.topicLegend = [];
			this.renderTopicLegend();
			return;
		}
		// Colors relative to the diversity of the works of this graph: the hue is the angle in the plane of meaning.
		const s = this.settings();
		const lightness = Math.min(0.9, Math.max(0.15, this.topicLightness() + (Number(s.graphTopicBrightness) || 0) / 100));
		const intensity = Math.max(0.1, (Number(s.graphTopicIntensity) || 100) / 100);
		const colored = new Map<SimNode, number>();
		for (const node of this.nodes) {
			const place = this.meaningById.get(node.data.id);
			node.topicColor = place ? colorOfPlace(place, lightness, intensity) : null;
			if (node.topicColor !== null && node.data.file) colored.set(node, node.topicColor);
		}
		// Works of the vault without any words: from the notes sharing their links.
		const links = this.app.metadataCache.resolvedLinks;
		const keywords = new Map<SimNode, Set<string>>();
		for (const node of this.nodes) {
			if (node.data.file) keywords.set(node, new Set(Object.keys(links[node.data.file.path] ?? {})));
		}
		for (const [node, color] of colorsFromSharedKeywords(keywords, colored)) node.topicColor = color;
		// Legend: OpenAlex's main topics of the graph, each in the color of the middle of its works.
		const info = (id: string) => this.openAlex.topicInfo(id);
		const topics = this.nodes.map((n) => this.workTopics(n));
		this.topicLegend = mainTopics(topics, TOPIC_LEGEND).map(({ id, works }) => {
			const places = this.nodes.flatMap((n, i) => {
				const place = topics[i]?.[0]?.[0] === id ? this.meaningById.get(n.data.id) : undefined;
				return place ? [place] : [];
			});
			const middle: [number, number] = [places.reduce((a, p) => a + p[0], 0) / (places.length || 1), places.reduce((a, p) => a + p[1], 0) / (places.length || 1)];
			return { name: topicName(id, info), works, color: places.length > 0 ? colorOfPlace(middle, lightness, intensity) : 0x888888 };
		});
		this.renderTopicLegend();
		this.invalidate();
	}

	/** The main topics of the graph and their colors, under "Color by" in the panel. */
	private renderTopicLegend(): void {
		const el = this.topicLegendEl;
		if (!el) return;
		el.empty();
		el.toggle(this.byMeaning());
		for (const topic of this.topicLegend) {
			const row = el.createDiv({ cls: 'literature-graph-topic' });
			row.createSpan({ cls: 'literature-graph-topic-swatch' }).setCssProps({ '--literature-graph-topic': hexColor(topic.color) });
			row.createSpan({ cls: 'literature-graph-topic-name', text: topic.name });
			row.createSpan({ cls: 'literature-graph-topic-count', text: String(topic.works) });
		}
		this.groupsEl?.toggle(!this.byMeaning());
	}

	/** Gives each note of the vault the color of its color group (settings). */
	applyColorGroups(): void {
		this.applyTopicColors();
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
			// The open control panel hides the right of the view, and the list of
			// suggestions its left: fit the graph between them.
			const open = [this.controlsEl, this.displayEl].find((p) => p && !p.hasClass('is-collapsed'));
			const bar = this.toolbarEl?.offsetWidth ?? 0;
			const right = open && open.offsetWidth + bar < screen.width / 2 ? open.offsetWidth + bar + 16 : bar;
			const list = this.suggestionsEl;
			const left = list && !list.hasClass('is-hidden') && list.offsetWidth < screen.width / 2 ? list.offsetWidth + 16 : 0;
			const width = screen.width - right - left;
			const fit = fitCamera(this.fitPoints(), width, screen.height, this.local ? LOCAL_START_SCALE : 1.5);
			if (fit) fit.x += (right - left) / 2 / fit.scale;
			return fit;
		}
		if (this.cameraMode === 'work') {
			const node = this.searchTarget;
			if (!node || node.x === undefined || node.y === undefined) return null;
			return { x: node.x, y: node.y, scale: Math.max(this.world.scale.x, SEARCH_SCALE) };
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
		// At rest: remember where each work is, for the next opening (global graph only).
		if (!update.moving && !this.local) this.savePositions();
	}

	/** Saves the positions of the works shown, for the current layout style. */
	private savePositions(): void {
		const saved: Record<string, [number, number]> = { ...this.positions.get(this.layoutStyle) };
		for (const node of this.nodes) {
			if (node.x === undefined || node.y === undefined) continue;
			saved[node.data.id] = [Math.round(node.x * 10) / 10, Math.round(node.y * 10) / 10];
		}
		this.positions.set(this.layoutStyle, saved);
	}

	/**
	 * The idle animation starts after a while without any input in the view's
	 * window (not only in the view: typing in a note beside the graph counts),
	 * and only a click in the graph stops it (moving the mouse lets it run).
	 */
	private watchActivity(): void {
		const activity = () => {
			this.lastActivity = Date.now();
		};
		// A click on the graph itself stops it (not in its panels or buttons); the click does nothing else.
		this.registerDomEvent(
			this.contentEl,
			'pointerdown',
			(e: PointerEvent) => {
				if (e.target !== this.pixi?.canvas) return;
				if (this.idle.running && performance.now() > this.idle.graceUntil) this.stopIdle();
			},
			{ capture: true },
		);
		// Only clicks count as activity (decision of the user): moving the
		// mouse, the wheel or the keyboard let the time run.
		this.registerDomEvent(this.contentEl.doc, 'pointerdown', activity, { capture: true, passive: true });
		this.registerInterval(
			window.setInterval(() => {
				const s = this.settings();
				const delay = Math.max(3, Number(s.graphIdleDelay) || 10) * 1000;
				// (An older "none" animation means off.)
				const enabled = s.graphIdleEnabled && s.graphIdleAnimation !== 'none';
				if (!this.idle.running && enabled && Date.now() - this.lastActivity >= delay) this.startIdle();
			}, 1000),
		);
	}

	/** The idle animation chosen (setting shared by every graph view), or "random". */
	private idleChoice(): IdleChoice {
		const chosen = this.settings().graphIdleAnimation;
		return isIdleChoice(chosen) ? chosen : 'sphere';
	}

	/** The animation to play now: the one chosen, or a random one other than the last. */
	private idleAnimation(): IdleAnimation {
		const chosen = this.idleChoice();
		return chosen === 'random' ? randomAnimation(this.idle.setup ? this.idle.animation : null) : chosen;
	}

	/** Seconds of animation since it started, at the pace of the speed setting. */
	private idleTime(now: number): number {
		const speed = Math.max(1, Number(this.settings().graphRotationSpeed) || NORMAL_SPEED);
		return ((now - this.idle.startedAt) / 1000) * (speed / NORMAL_SPEED);
	}

	/** Starts the idle animation, if the view can show it now (`grace`: milliseconds during which input does not stop it). */
	startIdle(grace = 0): void {
		const pixi = this.pixi;
		if (!pixi || this.paused || !this.contentEl.isShown() || this.dragged || this.nodes.length === 0) return;
		if (this.contentEl.win.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const placed = this.nodes.filter((n) => n.x !== undefined && n.y !== undefined);
		const sphere = fitSphere(placed.map((n) => ({ x: n.x ?? 0, y: n.y ?? 0 })));
		const year = (n: SimNode): number | null => {
			const work = n.data.openAlexId ? this.openAlex.cachedWork(n.data.openAlexId) : null;
			return work?.year ?? (n.data.entry?.year ? Number.parseInt(n.data.entry.year, 10) || null : null);
		};
		const rank = appearanceOrder(this.nodes.map((n) => ({ depth: n.data.depth, year: year(n), citedBy: n.data.citedBy })));
		// Each work grows out of its neighbor that appears first, if it appears before it.
		const anchor = this.nodes.map((n) => {
			let best: SimNode | null = null;
			for (const m of n.neighbors) {
				if ((rank[m.index] ?? 0) < (rank[n.index] ?? 0) && (!best || (rank[m.index] ?? 0) < (rank[best.index] ?? 0))) best = m;
			}
			return best;
		});
		const animation = this.idleAnimation();
		// The works cited by one work of the vault go together (on one orbit).
		const setup = setUpAnimation(
			this.nodes.map((n) => ({ x: n.x ?? 0, y: n.y ?? 0 })),
			sphere,
			(i) => {
				const node = this.nodes[i];
				if (!node || node.data.depth === 0) return i;
				for (const m of node.neighbors) if (m.data.depth === 0) return m.index;
				return i;
			},
		);
		this.idle = {
			...this.idle,
			animation,
			setup,
			zoom: 1,
			shown: new Float64Array(this.nodes.length * 2),
			running: true,
			startedAt: performance.now(),
			lastFrame: performance.now(),
			sphere,
			rank,
			anchor,
			appear: this.nodes.map(() => 1),
			front: this.nodes.map(() => 1),
			perspectiveScale: this.nodes.map(() => 1),
			returnTo: this.idle.level > 0 ? this.idle.returnTo : this.getCamera(),
			graceUntil: performance.now() + grace,
		};
		this.setHovered(null);
		this.requestFrame();
	}

	/** Stops the idle animation: the flat graph comes back, and the camera where it was. */
	private stopIdle(): void {
		this.idle.running = false;
		this.idle.lastFrame = performance.now();
		this.requestFrame();
	}

	/**
	 * One step of the idle animation: folds or unfolds the graph, turns the
	 * sphere, makes the works appear, and moves the camera. Returns whether it
	 * needs more frames.
	 */
	private stepIdle(now: number): boolean {
		const idle = this.idle;
		if (!idle.running && idle.level === 0) return false;
		const dt = Math.min(0.1, (now - idle.lastFrame) / 1000);
		idle.lastFrame = now;
		idle.level = idle.running
			? Math.min(1, idle.level + dt / IDLE_FOLD_SECONDS)
			: Math.max(0, idle.level - dt / IDLE_UNFOLD_SECONDS);
		const screen = this.pixi?.screen;
		const sphere = idle.sphere;
		if (idle.running && screen && sphere && framesShape(idle.animation)) {
			// The whole shape in view (the free drift stays where the graph is).
			const goal = { x: sphere.cx, y: sphere.cy, scale: clampScale(((Math.min(screen.width, screen.height) * SPHERE_FILL) / (2 * sphere.radius)) * idle.zoom) };
			this.setCamera(approach(this.getCamera(), goal, CAMERA_STEP / 2));
		} else if (!idle.running && idle.returnTo) {
			this.setCamera(idle.level === 0 ? idle.returnTo : approach(this.getCamera(), idle.returnTo, CAMERA_STEP * 2));
		}
		if (idle.level === 0) {
			idle.returnTo = null;
			for (const node of this.nodes) node.sprite.scale.set(this.drawnRadius(node) / CIRCLE_TEXTURE_RADIUS);
		}
		this.edgesDirty = true;
		return idle.running || idle.level > 0;
	}

	/**
	 * Moves the nodes to where the sphere shows them (for drawing only), and
	 * returns their layout positions, to put back after drawing.
	 */
	private projectIdle(now: number): Float64Array {
		const idle = this.idle;
		const saved = new Float64Array(this.nodes.length * 2);
		const setup = idle.setup;
		if (!setup) return saved;
		const s = this.settings();
		const t = this.idleTime(now);
		// How many works have appeared (all of them when stopping, or without the setting).
		const grown =
			idle.running && s.graphAppearOneByOne
				? (Math.max(0, (now - idle.startedAt) / 1000 - IDLE_FOLD_SECONDS) / APPEAR_SECONDS) * this.nodes.length
				: Infinity;
		const level = idle.level;
		const ease = (t: number) => 1 - (1 - t) * (1 - t);
		const byRank = [...this.nodes].sort((a, b) => (idle.rank[a.index] ?? 0) - (idle.rank[b.index] ?? 0));
		const shown = new Map<SimNode, { x: number; y: number; scale: number; front: number }>();
		for (const node of byRank) {
			const x = node.x ?? 0;
			const y = node.y ?? 0;
			saved[node.index * 2] = x;
			saved[node.index * 2 + 1] = y;
			const own = placeWork(idle.animation, setup, node.index, x, y, t);
			const appear = Math.min(1, Math.max(0, grown - (idle.rank[node.index] ?? 0)));
			idle.appear[node.index] = appear;
			// Not fully there yet: on its way out of the work it grows from.
			const from = appear < 1 ? shown.get(idle.anchor[node.index] ?? node) : undefined;
			const p = from
				? { ...own, x: from.x + (own.x - from.x) * ease(appear), y: from.y + (own.y - from.y) * ease(appear) }
				: own;
			shown.set(node, p);
			idle.front[node.index] = own.front;
			idle.perspectiveScale[node.index] = own.scale;
			node.x = x + (p.x - x) * level;
			node.y = y + (p.y - y) * level;
			idle.shown[node.index * 2] = node.x;
			idle.shown[node.index * 2 + 1] = node.y;
		}
		return saved;
	}

	/**
	 * The constellation's signals: bright dots running along citations, from
	 * the citing work to the cited one, at the works' drawn places.
	 */
	private drawSignals(now: number, theme: Theme): void {
		const idle = this.idle;
		const on = idle.level > 0 && hasSignals(idle.animation) && this.links.length > 0;
		this.signalsLayer.visible = on;
		if (!on) return;
		const list = signals(SIGNALS, this.links.length, this.idleTime(now));
		while (this.signalSprites.length < list.length) {
			const sprite = new Sprite(this.circleTexture ?? Texture.WHITE);
			sprite.anchor.set(0.5);
			this.signalsLayer.addChild(sprite);
			this.signalSprites.push(sprite);
		}
		const size = SIGNAL_RADIUS / this.world.scale.x / CIRCLE_TEXTURE_RADIUS;
		list.forEach(({ link, along }, k) => {
			const sprite = this.signalSprites[k];
			const l = this.links[link];
			if (!sprite || !l) return;
			const there = (idle.appear[l.source.index] ?? 1) >= 1 && (idle.appear[l.target.index] ?? 1) >= 1;
			sprite.visible = there && !this.outOfTime(l.source) && !this.outOfTime(l.target);
			const sx = l.source.x ?? 0;
			const sy = l.source.y ?? 0;
			sprite.position.set(sx + ((l.target.x ?? 0) - sx) * along, sy + ((l.target.y ?? 0) - sy) * along);
			sprite.tint = theme.focused.color;
			// Fades in as it leaves, out as it arrives.
			sprite.alpha = Math.sin(Math.PI * along) * idle.level;
			sprite.scale.set(size);
		});
	}

	/**
	 * Whether an edge is hidden in the idle animation: when one of its works has
	 * not appeared yet, unless that work is growing out of the other one.
	 */
	private readonly idleHiddenEdge = (link: SimLink): boolean => {
		const a = this.idle.appear[link.source.index] ?? 1;
		const b = this.idle.appear[link.target.index] ?? 1;
		if (a >= 1 && b >= 1) return false;
		const growing = (a < 1 && this.idle.anchor[link.source.index] === link.target) || (b < 1 && this.idle.anchor[link.target.index] === link.source);
		return !(growing && Math.min(a, b) > 0);
	};

	/** After drawing the sphere: sizes and alphas by depth and appearance, then the layout positions back. */
	private finishIdle(saved: Float64Array): void {
		const idle = this.idle;
		const level = idle.level;
		for (const node of this.nodes) {
			const x = saved[node.index * 2] ?? 0;
			const y = saved[node.index * 2 + 1] ?? 0;
			const front = idle.front[node.index] ?? 1;
			const perspectiveScale = idle.perspectiveScale[node.index] ?? 1;
			const appear = idle.appear[node.index] ?? 1;
			const factor = 1 + ((BACK_ALPHA + (1 - BACK_ALPHA) * front) * appear - 1) * level;
			node.sprite.alpha *= factor;
			node.sprite.scale.set((this.drawnRadius(node) / CIRCLE_TEXTURE_RADIUS) * (1 + (perspectiveScale * Math.max(0.05, appear) - 1) * level));
			if (node.label?.visible) {
				node.label.alpha *= factor;
				if (appear < 1) node.label.visible = false;
			}
			node.x = x;
			node.y = y;
		}
	}

	/**
	 * Forgets the saved places of the works (for this style) and lays the
	 * graph out from scratch, as at its very first opening.
	 */
	private resetLayout(): void {
		if (!this.local) this.positions.set(this.layoutStyle, {});
		for (const node of this.nodes) {
			node.x = undefined;
			node.y = undefined;
		}
		this.nodes = [];
		if (!this.local) this.cameraMode = 'fit';
		this.showCurrent();
	}

	/** Whether the timeline hides a work (published after the year chosen). */
	private outOfTime(node: SimNode): boolean {
		if (this.yearLimit === null) return false;
		const year = this.years[node.index];
		return year !== null && year !== undefined && year > this.yearLimit;
	}

	/** The year of each work shown (property of a note, OpenAlex, or reference list), and the timeline's range. */
	private readYears(): void {
		this.years = this.nodes.map((n) => {
			if (n.data.file) {
				const year = Number.parseInt(this.index.vaultWork(n.data.file)?.year ?? '', 10);
				return Number.isFinite(year) ? year : null;
			}
			const work = n.data.openAlexId ? this.openAlex.cachedWork(n.data.openAlexId) : null;
			if (work?.year) return work.year;
			const entry = Number.parseInt(n.data.entry?.year ?? '', 10);
			return Number.isFinite(entry) ? entry : null;
		});
		const known = this.years.filter((y): y is number => y !== null && y > 1000 && y < 3000);
		const slider = this.yearSlider;
		if (!slider || known.length === 0) return;
		const min = Math.min(...known);
		const max = Math.max(...known);
		slider.setLimits(min, max, 1);
		this.showYearOnSlider(this.yearLimit ?? max);
		this.describeTimeline();
	}

	/**
	 * The time axis of the chronological layout: a faint vertical line and a
	 * label for each decade, at the place the layout gives its works (see
	 * `yearScale`), then "?" for the works of unknown year. Built again with
	 * each graph; hidden for the other styles.
	 */
	private buildTimeAxis(): void {
		const layer = this.axisLayer;
		for (const child of layer.removeChildren()) child.destroy({ children: true });
		layer.visible = this.layoutStyle === 'chronological';
		const theme = this.theme;
		if (!layer.visible || !theme) return;
		const known = this.years.filter((y): y is number => y !== null && y > 1000 && y < 3000);
		if (known.length === 0) return;
		const width = timelineWidth(this.nodes.length);
		const x = yearScale(this.years.map(plausibleYear), width);
		// Sizes in world units: the axis grows and shrinks with the zoom, like the graph.
		const fontSize = Math.max(48, width / 70);
		const tick = fontSize * 0.4;
		const stroke = Math.max(2, width / 1500);
		// The top (axis, ticks, years) is drawn at y = 0, and the grid from 0
		// to 1: `placeTimeAxis` moves them to the top of the works and stretches
		// the grid down to their bottom.
		const top = new Container();
		const grid = new Graphics();
		const axis = new Graphics();
		const first = Math.ceil(Math.min(...known) / 10) * 10;
		const last = Math.max(...known);
		axis.moveTo(x(Math.min(...known)), 0).lineTo(x(last), 0);
		let lastLabel = -Infinity;
		const mark = (at: number, text: string) => {
			grid.moveTo(at, 0).lineTo(at, 1);
			axis.moveTo(at, 0).lineTo(at, -tick);
			// Decades crowded by the scale: only labels far enough apart.
			if (at - lastLabel < fontSize * 2.6) return;
			lastLabel = at;
			const label = new Text({ text, style: { fontSize, fontWeight: '600', fill: theme.text.color, fontFamily: theme.fontFamily } });
			label.anchor.set(0.5, 1);
			label.alpha = 0.85;
			label.position.set(at, -tick - fontSize * 0.2);
			top.addChild(label);
		};
		for (let decade = first; decade <= last; decade += 10) mark(x(decade), String(decade));
		if (this.years.some((y) => plausibleYear(y) === null)) mark(unknownYearX(width), '?');
		grid.stroke({ width: stroke / 2, color: theme.line.color, alpha: 0.45 });
		axis.stroke({ width: stroke, color: theme.text.color, alpha: 0.7 });
		top.addChildAt(axis, 0);
		layer.addChild(grid, top);
		this.axisParts = { top, grid, margin: fontSize };
	}

	/** Keeps the time axis just above the works, and its grid down through them. */
	private placeTimeAxis(): void {
		const parts = this.axisParts;
		if (!parts || !this.axisLayer.visible || this.nodes.length === 0) return;
		// Hidden during the idle animation, where the works are elsewhere for a while.
		this.axisLayer.alpha = 1 - this.idle.level;
		if (this.idle.level > 0) return;
		let min = Infinity;
		let max = -Infinity;
		for (const node of this.nodes) {
			const y = node.y ?? 0;
			if (y < min) min = y;
			if (y > max) max = y;
		}
		const y = min - parts.margin;
		parts.top.y = y;
		parts.grid.y = y;
		parts.grid.scale.y = Math.max(1, max - min + parts.margin * 2);
	}

	/** Moves the year slider without it counting as the user's choice (which stops the timeline). */
	private showYearOnSlider(year: number): void {
		this.movingYearSlider = true;
		try {
			this.yearSlider?.setValue(year);
		} finally {
			this.movingYearSlider = false;
		}
	}

	/** Shows the works published up to a year (null: all of them). */
	private setYearLimit(year: number | null): void {
		this.yearLimit = year;
		this.describeTimeline();
		this.invalidate();
	}

	private describeTimeline(): void {
		const shown = this.yearLimit === null ? this.nodes.length : this.nodes.filter((n) => !this.outOfTime(n)).length;
		this.timelineDesc?.setText(this.yearLimit === null ? 'All years.' : `Published up to ${this.yearLimit}: ${shown} works.`);
	}

	/**
	 * Plays the timeline: the literature grows year by year, up to today. Years
	 * in which no work shown was published are skipped.
	 */
	private playTimeline(): void {
		this.stopTimeline();
		const years = [...new Set(this.years.filter((y): y is number => y !== null && y > 1000 && y < 3000))].sort(
			(a, b) => a - b,
		);
		if (years.length === 0) return;
		let step = 0;
		const show = () => {
			this.showYearOnSlider(years[step]!);
			this.setYearLimit(step === years.length - 1 ? null : years[step]!);
		};
		show();
		if (years.length === 1) return;
		this.timelineTimer = window.setInterval(() => {
			step++;
			show();
			if (step >= years.length - 1) this.stopTimeline();
		}, TIMELINE_YEAR_MS);
	}

	private stopTimeline(): void {
		if (this.timelineTimer !== null) window.clearInterval(this.timelineTimer);
		this.timelineTimer = null;
	}

	/**
	 * The search field, at the top left of the view: typing shows the works
	 * matching the text (authors, year, title); choosing one moves the camera
	 * to it and highlights it, until the view is moved.
	 */
	private buildSearch(container: HTMLElement): void {
		const box = container.createDiv({ cls: 'literature-graph-search' });
		const input = box.createEl('input', { type: 'search', attr: { placeholder: 'Find a work', 'aria-label': 'Find a work in the graph' } });
		new WorkSuggest(
			this.app,
			input,
			() => this.nodes.map((n) => n.data),
			(work) => this.goToWork(work.id),
		);
	}

	/** Moves the camera to a work of the graph and highlights it. */
	private goToWork(id: string): void {
		const node = this.nodes.find((n) => n.data.id === id);
		if (!node) return;
		this.searchTarget = node;
		this.cameraMode = 'work';
		this.zoom = null;
		this.setHovered(node);
	}

	/**
	 * The list of reading suggestions, at the left of the view: the works
	 * outside the vault of the graph shown, most relevant first (see
	 * `relevance.ts`). Hovering a row highlights the work in the graph, as
	 * hovering its node does; clicking it opens its ghost note.
	 */
	private buildSuggestions(container: HTMLElement): void {
		const list = container.createDiv({ cls: 'literature-graph-suggestions is-hidden' });
		this.suggestionsEl = list;
		list.addEventListener('mouseleave', () => this.setHovered(null));
	}

	/** Opens or closes the list of reading suggestions. */
	toggleSuggestions(open?: boolean): void {
		const list = this.suggestionsEl;
		if (!list) return;
		const show = open ?? list.hasClass('is-hidden');
		list.toggleClass('is-hidden', !show);
		this.suggestionsShown = SUGGESTIONS_PAGE;
		this.renderSuggestions();
		if (this.cameraMode === 'fit') this.requestFrame();
	}

	private renderSuggestions(): void {
		const list = this.suggestionsEl;
		if (!list || list.hasClass('is-hidden')) return;
		const scroll = list.scrollTop;
		list.empty();
		const header = list.createDiv({ cls: 'literature-graph-suggestions-header' });
		header.createDiv({ cls: 'literature-graph-suggestions-title', text: 'Reading suggestions' });
		const close = header.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': 'Close' } });
		setIcon(close, 'x');
		close.addEventListener('click', () => this.toggleSuggestions(false));
		const tabs = list.createDiv({ cls: 'literature-graph-suggestions-tabs' });
		for (const [missing, name] of [
			[false, 'All works'],
			[true, 'Not on OpenAlex'],
		] as const) {
			const tab = tabs.createDiv({ cls: 'literature-graph-suggestions-tab', text: name });
			tab.toggleClass('is-active', this.suggestionsMissing === missing);
			tab.addEventListener('click', () => {
				this.suggestionsMissing = missing;
				this.suggestionsShown = SUGGESTIONS_PAGE;
				list.scrollTop = 0;
				this.renderSuggestions();
			});
		}
		const graph = this.shownGraph;
		const all = graph ? rankSuggestions(graph, cachedInfo(this.openAlex)) : [];
		// Works OpenAlex does not know: known only from a reference list (or by a
		// DOI it does not have), to be found by hand.
		const ranked = this.suggestionsMissing ? all.filter((s) => s.node.openAlexId === null) : all;
		if (ranked.length === 0) {
			list.createDiv({
				cls: 'literature-graph-suggestions-empty',
				text: this.suggestionsMissing
					? 'Every work outside your vault in this graph is on OpenAlex.'
					: 'No works outside your vault in this graph. Show depth 1 or 2 in the graph settings.',
			});
			return;
		}
		list.createDiv({
			cls: 'literature-graph-suggestions-desc',
			text: this.suggestionsMissing
				? `${ranked.length} works cited in your notes that OpenAlex does not know, most relevant first, with their reference as written in your notes, to find them by hand.`
				: 'Works outside your vault, most cited by your works first. Hover a work to see why, and where it is in the graph; click it to see its note-to-be.',
		});
		const byId = new Map(this.nodes.map((n) => [n.data.id, n]));
		ranked.slice(0, this.suggestionsShown).forEach((suggestion, i) => {
			const node = byId.get(suggestion.node.id);
			if (!node) return;
			const row = list.createDiv({ cls: 'literature-graph-suggestion' });
			row.createSpan({ cls: 'literature-graph-suggestion-rank', text: `${i + 1}` });
			const text = row.createDiv({ cls: 'literature-graph-suggestion-text' });
			text.createDiv({ cls: 'literature-graph-suggestion-label', text: suggestion.node.label });
			// (Without the emphasis marks of the converted notes: "*Title*", "**17:**".)
			const reference =
				suggestion.node.entry?.text.replace(/\*+/g, '') ?? (suggestion.node.doi ? `https://doi.org/${suggestion.node.doi}` : '');
			if (this.suggestionsMissing && reference) {
				text.createDiv({ cls: 'literature-graph-suggestion-reference', text: reference });
				this.buildMissingActions(text, reference, suggestion.node.title || reference);
			} else if (suggestion.node.title) {
				text.createDiv({ cls: 'literature-graph-suggestion-title', text: suggestion.node.title });
			}
			row.createSpan({ cls: 'literature-graph-suggestion-score', text: suggestion.score.toFixed(1) });
			setTooltip(row, [`Score ${suggestion.score}`, ...explainSuggestion(suggestion)].join('\n'), { placement: 'right' });
			row.addEventListener('mouseenter', () => this.setHovered(node));
			row.addEventListener('click', (e) => this.openNode(node, e));
		});
		if (ranked.length > this.suggestionsShown) {
			const more = list.createEl('button', {
				cls: 'literature-graph-suggestions-more',
				text: `Show more (${ranked.length - this.suggestionsShown} left)`,
			});
			more.addEventListener('click', () => {
				this.suggestionsShown += SUGGESTIONS_PAGE;
				this.renderSuggestions();
			});
		}
		list.scrollTop = scroll;
	}

	/** Buttons of a work OpenAlex does not know: copy its reference, or search for it on the web. */
	private buildMissingActions(parent: HTMLElement, reference: string, query: string): void {
		const actions = parent.createDiv({ cls: 'literature-graph-suggestion-actions' });
		const action = (icon: string, label: string, run: () => void) => {
			const button = actions.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': label } });
			setIcon(button, icon);
			button.addEventListener('click', (e) => {
				// Not the row's click, which opens the ghost note.
				e.stopPropagation();
				run();
			});
		};
		action('copy', 'Copy the reference', () => {
			void navigator.clipboard.writeText(reference).then(() => new Notice('Reference copied.'));
		});
		action('search', 'Search for it on Google Scholar', () => {
			window.open(`https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`);
		});
	}

	/**
	 * The buttons of the view, in a column along its right edge: the graph's
	 * settings, its display (layout and idle animation), the reading
	 * suggestions and fitting the graph to the view. The two panels open to
	 * the left of the column, one at a time; the button of an open panel
	 * becomes a cross.
	 */
	private buildControls(container: HTMLElement): void {
		// The column of buttons, then the open panel to its left (see styles.css).
		const side = container.createDiv({ cls: 'literature-graph-side' });
		const toolbar = side.createDiv({ cls: 'literature-graph-toolbar' });
		this.toolbarEl = toolbar;
		const button = (icon: string, label: string) => {
			const el = toolbar.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': label } });
			setIcon(el, icon);
			return el;
		};
		const settingsButton = button('settings', 'Open graph settings');
		const displayButton = button('shapes', 'Open display: layout and idle animation');
		button('list-ordered', 'Reading suggestions').addEventListener('click', () => this.toggleSuggestions());
		button('maximize', 'Fit the graph to the view').addEventListener('click', () => this.fitToView());

		const panel = side.createDiv({ cls: 'literature-graph-controls is-collapsed' });
		this.controlsEl = panel;
		const body = panel.createDiv({ cls: 'literature-graph-controls-body' });
		const displayPanel = side.createDiv({ cls: 'literature-graph-controls literature-graph-display is-collapsed' });
		this.displayEl = displayPanel;
		const display = displayPanel.createDiv({ cls: 'literature-graph-controls-body' });
		const panels = [
			{ panel, button: settingsButton, icon: 'settings', open: 'Open graph settings', close: 'Close graph settings' },
			{ panel: displayPanel, button: displayButton, icon: 'shapes', open: 'Open display: layout and idle animation', close: 'Close display' },
		];
		/** Opens one panel (closing the other), or closes them all (null). */
		const setOpen = (which: HTMLElement | null) => {
			for (const p of panels) {
				const open = p.panel === which;
				p.panel.toggleClass('is-collapsed', !open);
				if (!open) p.panel.scrollTop = 0;
				setIcon(p.button, open ? 'x' : p.icon);
				p.button.setAttribute('aria-label', open ? p.close : p.open);
				p.button.toggleClass('is-active', open);
			}
			// The room left for the graph changed.
			if (this.cameraMode === 'fit') this.requestFrame();
		};
		setOpen(null);
		for (const p of panels) p.button.addEventListener('click', () => setOpen(p.panel.hasClass('is-collapsed') ? p.panel : null));
		// A click anywhere in the view outside the open panel and the buttons
		// closes it (and still does what it does). The listener is on the view,
		// not on its document, so that it follows the view into a pop-out window.
		this.registerDomEvent(
			container,
			'pointerdown',
			(e: PointerEvent) => {
				// (No `instanceof Node`: in a pop-out window, nodes belong to another realm.)
				const target = e.target as Node | null;
				if (!target || toolbar.contains(target)) return;
				if (panels.some((p) => !p.panel.hasClass('is-collapsed') && !p.panel.contains(target))) setOpen(null);
			},
			{ capture: true },
		);
		this.buildDisplay(display, () => setOpen(null));

		const reloadSoon = debounce(() => void this.loadData(), 600, true);
		const relayoutSoon = debounce(
			() => {
				this.showCurrent();
				this.layout?.send({ type: 'reheat', alpha: 0.6 });
			},
			500,
			true,
		);
		new Setting(body).setName('Filter').addSearch((search) =>
			search.setPlaceholder('Author, year or title').onChange((value) => {
				this.filter = value.trim().toLowerCase();
				this.labelMatches();
				this.invalidate();
			}),
		);
		new Setting(body)
			.setName('Local depth')
			.setDesc('Local graph: how many citations away from the active note.')
			.setClass('literature-graph-local-only')
			.addSlider((slider) => {
				slider.setLimits(1, 3, 1).setValue(this.localDepth).onChange((value) => {
					this.localDepth = value;
					this.showCurrent();
					void this.app.workspace.requestSaveLayout();
				});
				this.syncControls.push(() => {
					slider.setValue(this.localDepth);
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
			.setName('Depth')
			.setDesc('Works outside the vault cited by it (1), and by those (2).')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ '0': '0', '1': '1', '2': '2' })
					.setValue(String(this.options.depth))
					.onChange((value) => {
						this.options.depth = Number(value);
						reloadSoon();
					}),
			);
		new Setting(body)
			.setName('Works without a DOI')
			.setDesc('Works of the reference lists that have no DOI, known only from your notes (depth 1).')
			.addToggle((toggle) =>
				toggle.setValue(this.options.localWorks !== false).onChange((value) => {
					this.options.localWorks = value;
					reloadSoon();
				}),
			);
		new Setting(body)
			.setName('All notes of the vault')
			.setDesc('Also the notes outside the literature folder linked by citation links.')
			.addToggle((toggle) =>
				toggle.setValue(this.options.allNotes === true).onChange((value) => {
					this.options.allNotes = value;
					reloadSoon();
				}),
			);
		const sources: [EdgeSource, string][] = [
			['link', 'Citation links'],
			['bibliography', 'Reference lists'],
			['openalex', 'OpenAlex'],
		];
		const from = new Setting(body).setName('Citations from').setDesc('Where the citations drawn are found.');
		for (const [source, name] of sources) {
			const label = from.controlEl.createEl('label', { cls: 'literature-graph-source' });
			const box = label.createEl('input', { type: 'checkbox' });
			box.checked = this.options.edgeSources?.[source] !== false;
			label.appendText(name);
			box.addEventListener('change', () => {
				this.options.edgeSources = { ...this.options.edgeSources, [source]: box.checked };
				reloadSoon();
			});
		}
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
		this.buildColors(body);
		this.groupsEl = body.createDiv();
		this.buildGroups(this.groupsEl);
		this.renderTopicLegend();
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
		new Setting(body)
			.setName('Point size')
			.setDesc('Kept for every graph.')
			.addSlider((slider) => {
				slider
					.setLimits(0.25, 3, 0.05)
					.setValue(Number(this.settings().graphPointScale) || 1)
					.onChange((value) => {
						this.invalidate();
						this.requestFrame();
						void this.saveSettings({ graphPointScale: value });
						// The spacing follows the size: the layout starts again, from where the works are.
						relayoutSoon();
					});
				this.syncControls.push(() => {
					slider.setValue(Number(this.settings().graphPointScale) || 1);
				});
			});
		new Setting(body).setName('Center force').addSlider((slider) =>
			slider
				.setLimits(0, 0.2, 0.005)
				.setValue(this.forces.center)
				.onChange((value) => {
					this.forces.center = value;
					this.applyForces();
				}),
		);
		// Only in the Meaning layout.
		const meaningAttraction = new Setting(body)
			.setName('Meaning attraction')
			.setDesc('Works of one meaning gather in balls; works between two meanings, between their balls. Higher: denser balls, more decided groups.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 5, 0.1)
					.setValue(this.forces.meaning)
					.onChange((value) => {
						this.forces.meaning = value;
						// The places the works are drawn to depend on it: the layout starts again, from where the works are.
						relayoutSoon();
					}),
			);
		const showMeaningAttraction = () => meaningAttraction.settingEl.toggle(this.layoutStyle === 'meaning');
		showMeaningAttraction();
		this.syncControls.push(showMeaningAttraction);
		const timeline = new Setting(body).setName('Timeline');
		this.timelineDesc = timeline.descEl;
		timeline
			.addSlider((slider) => {
				this.yearSlider = slider;
				slider.setLimits(1900, 2030, 1).setValue(2030);
				slider.onChange((value) => {
					if (this.movingYearSlider) return;
					this.stopTimeline();
					const known = this.years.filter((y): y is number => y !== null && y > 1000 && y < 3000);
					this.setYearLimit(known.length > 0 && value >= Math.max(...known) ? null : value);
				});
			})
			.addExtraButton((button) =>
				button
					.setIcon('play')
					.setTooltip('Play: the literature year by year')
					.onClick(() => this.playTimeline()),
			);
		this.describeTimeline();
		this.register(() => this.stopTimeline());
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
		// In these narrow panels, a setting with a description puts it above its
		// controls (a class rather than a CSS :has, which is slow to match).
		for (const item of [...body.querySelectorAll<HTMLElement>('.setting-item'), ...display.querySelectorAll<HTMLElement>('.setting-item')]) {
			if (item.querySelector('.setting-item-description')?.textContent?.trim()) item.addClass('literature-graph-setting-stacked');
		}
	}

	/**
	 * The display panel: the style of layout (for as long as the view is
	 * open; its default is in the settings) and the idle animation (kept for
	 * every graph), with the buttons to lay the graph out again.
	 */
	private buildDisplay(body: HTMLElement, close: () => void): void {
		new Setting(body)
			.setName('Layout')
			.setDesc('For as long as the view is open; the default is in the plugin settings. Meaning: works on related subjects gather in clouds.')
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({ ...LAYOUT_STYLES })
					.setValue(this.layoutStyle)
					.onChange((value) => {
						this.layoutStyle = isLayoutStyle(value) ? value : 'default';
						for (const sync of this.syncControls) sync();
						// A new layout from the positions shown: the works move to their new places.
						this.showCurrent();
						this.layout?.send({ type: 'reheat', alpha: 1 });
						if (!this.local) this.cameraMode = 'fit';
					});
				this.syncControls.push(() => {
					dropdown.setValue(this.layoutStyle);
				});
			});
		// Only in the Meaning layout.
		const regions = new Setting(body)
			.setName('Regions')
			.setDesc('A circle around each group of meaning, named by the keyword most typical of its works. Kept for every graph.')
			.addToggle((toggle) => {
				toggle.setValue(this.settings().graphShowRegions === true).onChange((value) => {
					void this.saveSettings({ graphShowRegions: value });
					this.regionsPlacedAt = 0;
					this.requestFrame();
				});
				this.syncControls.push(() => {
					toggle.setValue(this.settings().graphShowRegions === true);
				});
			});
		const showRegions = () => regions.settingEl.toggle(this.layoutStyle === 'meaning');
		showRegions();
		this.syncControls.push(showRegions);
		new Setting(body).addButton((button) =>
			button
				.setButtonText('Reset layout')
				.setTooltip('Forget the saved places of the works and lay the graph out from scratch')
				.onClick(() => this.resetLayout()),
		);
		new Setting(body)
			.setName('Idle animation')
			.setDesc('Kept for every graph. A click on the graph stops it; switch and delay in the plugin settings.')
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({ ...IDLE_CHOICES })
					.setValue(this.idleChoice())
					.onChange((value) => void this.saveSettings({ graphIdleAnimation: value }));
				this.syncControls.push(() => {
					dropdown.setValue(this.idleChoice());
				});
			})
			.addButton((button) =>
				button.setButtonText('Play').onClick(() => {
					close();
					this.startIdle(1500);
				}),
			);
	}

	/** How the works are colored: by color groups or by topic, with the gradient and the legend of the topics. */
	private buildColors(body: HTMLElement): void {
		new Setting(body)
			.setName('Color by')
			.setDesc('Color groups, or the meaning of the works (their words): the more two works differ, compared with all the works of the graph, the further apart their hues.')
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({ groups: 'Color groups', meaning: 'Meaning' })
					.setValue(this.byMeaning() ? 'meaning' : 'groups')
					.onChange((value) => void this.saveSettings({ graphColorBy: value }));
				this.syncControls.push(() => {
					dropdown.setValue(this.byMeaning() ? 'meaning' : 'groups');
				});
			});
		this.topicLegendEl = body.createDiv({ cls: 'literature-graph-topics' });
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
		const save = () => void this.saveSettings({ graphColorGroups: formatColorGroups(groups, this.settings().graphColorGroups) });
		const saveSoon = debounce(save, 500, true);
		// What queries can name, from the notes of the graph (read when needed).
		const queryData = () =>
			collectQueryData(
				this.app,
				this.app.vault.getMarkdownFiles().filter((f) => this.index.isLiterature(f)),
			);
		const render = () => {
			list.empty();
			groups.forEach((group, i) => {
				new Setting(list)
					.setClass('literature-graph-group')
					.addText((text) => {
						text
							.setPlaceholder('Query, such as tag:#name')
							.setValue(group.query)
							.onChange((value) => {
								group.query = value;
								saveSoon();
							});
						new QuerySuggest(this.app, text.inputEl, queryData);
					})
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
			// "New group": pick what the group is (a tag, a property's value, a
			// folder) from a menu, without typing the query; or type it, with
			// suggestions.
			new Setting(list).addButton((button) =>
				button.setButtonText('New group').onClick((event: MouseEvent) =>
					showNewGroupMenu(this.app, event, queryData, (query) => {
						groups.push({ query, color: GROUP_PALETTE[groups.length % GROUP_PALETTE.length] ?? '#d9a441' });
						render();
						const complete = query !== '' && !query.endsWith(':');
						if (complete) {
							save();
							return;
						}
						// The new group's query field, ready to type in.
						const input = list.querySelectorAll<HTMLInputElement>('input[type="text"]').item(groups.length - 1);
						input?.focus();
						input?.setSelectionRange(query.length, query.length);
					}),
				),
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
		// The idle animation, after the camera: it moves the camera itself.
		const now = performance.now();
		if (this.stepIdle(now)) again = true;
		if (this.world.scale.x !== this.lastEdgeScale) this.edgesDirty = true;

		const saved = this.idle.level > 0 ? this.projectIdle(now) : null;
		this.placeTimeAxis();
		if (this.placeRegions(now)) again = true;
		this.draw(theme);
		this.drawSignals(now, theme);
		if (saved) this.finishIdle(saved);
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
			// Widths in pixels on screen, whatever the zoom: thin lines, and the
			// hovered work's arrows thicker.
			const arrow = scale > ARROW_MIN_SCALE ? ARROW_SIZE / Math.max(scale, 1) : 0;
			// In the idle animation, the edges of works not there yet are not drawn.
			const hidden =
				this.yearLimit !== null
					? (link: SimLink) => this.outOfTime(link.source) || this.outOfTime(link.target) || (this.idle.level > 0 && this.idleHiddenEdge(link))
					: this.idle.level > 0
						? this.idleHiddenEdge
						: undefined;
			this.vaultEdges.update(EDGE_WIDTH / scale, arrow, hidden);
			this.outsideEdges.update(EDGE_WIDTH / scale, arrow, hidden);
			this.focusOutEdges.update(FOCUS_EDGE_WIDTH / scale, arrow);
			this.focusInEdges.update(FOCUS_EDGE_WIDTH / scale, arrow);
		}
		const lerp = (a: number, b: number) => a + (b - a) * level;
		// Lines fade as the view zooms out, so the works stay readable; the
		// hovered work's arrows do not. Most idle animations fade them out too,
		// so that every work moves freely.
		const idleFade = this.idle.level > 0 && !keepsEdges(this.idle.animation) ? 1 - this.idle.level : 1;
		// The chronological layout shows only the lines of the highlighted work
		// (decision of the user); the Meaning layout, a faint trace of them: its
		// long lines across the clouds would otherwise veil their colors.
		const styleFade = this.layoutStyle === 'chronological' ? 0 : this.layoutStyle === 'meaning' ? MEANING_EDGE_FADE : 1;
		const zoomFade = idleFade * Math.min(1, Math.max(EDGE_FADE_MIN, (scale - EDGE_FADE_FROM) / (EDGE_FADE_TO - EDGE_FADE_FROM)));
		this.vaultEdges.style(theme.line, styleFade * lerp(theme.line.alpha * zoomFade, DIMMED_EDGE_ALPHA * zoomFade));
		this.outsideEdges.style(theme.line, styleFade * lerp(theme.line.alpha * 0.45 * zoomFade, DIMMED_EDGE_ALPHA * zoomFade));
		this.focusOutEdges.style(theme.focused, theme.focused.alpha * level);
		this.focusInEdges.style(theme.incoming, theme.incoming.alpha * level);

		for (const node of this.nodes) {
			const near = !focus || node === focus || focus.neighbors.has(node);
			const topic = node.topicColor;
			const base =
				(node === focus && level > 0.5) || (this.local && node.data.id === this.center)
					? theme.focused
					: topic !== null
						? this.topicShade(topic, node.data.depth, theme)
						: node.data.depth === 0
							? (node.groupColor ?? theme.node)
							: node.data.depth === 1
								? theme.outside
								: theme.outside2;
			const sprite = node.sprite;
			sprite.position.set(node.x ?? 0, node.y ?? 0);
			// (The idle animation sets the sizes itself, after drawing.)
			if (this.idle.level === 0) sprite.scale.set(this.drawnRadius(node) / CIRCLE_TEXTURE_RADIUS);
			// Around the highlighted work, its neighbors take the color of their
			// arrows: cited works the accent, citing works orange (both: between).
			const cited = focus && node !== focus && this.focusCited.has(node);
			const citing = focus && node !== focus && this.focusCiting.has(node);
			const arrowColor =
				cited && citing
					? mixColor(theme.focused.color, theme.incoming.color, 0.5)
					: cited
						? theme.focused.color
						: citing
							? theme.incoming.color
							: null;
			sprite.tint = arrowColor === null ? base.color : mixColor(base.color, arrowColor, NEIGHBOR_TINT * level);
			sprite.alpha = base.alpha * (near ? 1 : lerp(1, 0.2)) * (this.matches(node) ? 1 : 0.2);
			sprite.visible = !this.outOfTime(node);
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
			if (this.outOfTime(node)) {
				label.visible = false;
				continue;
			}
			const normal = this.filter
				? this.matches(node)
					? 1
					: 0
				: this.local
					? 1
					: node.data.depth === 0
						? fade
						: 0;
			let alpha = normal;
			let tier = node.data.depth === 0 ? 1 : 0;
			if (focus) {
				const near = node === focus || focus.neighbors.has(node);
				alpha = lerp(normal, near ? 1 : node.data.depth === 0 ? 0.1 * fade : 0);
				if (node === focus) tier = 4;
				else if (near) tier += 2;
			}
			label.visible = false;
			if (alpha <= 0.01) continue;
			label.alpha = alpha;
			label.position.set(node.x ?? 0, (node.y ?? 0) + this.drawnRadius(node) + 3);
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

	/** A topic color as drawn: as is in the vault, darker (or paler) outside it, like the usual colors. */
	private topicShade(color: number, depth: number, theme: Theme): ThemeColor {
		if (depth === 0) return { color, alpha: theme.node.alpha };
		const outside = mixColor(color, theme.background.color, TOPIC_OUTSIDE_BLEND);
		return { color: depth === 1 ? outside : mixColor(outside, theme.background.color, DEPTH_2_BLEND), alpha: theme.outside.alpha };
	}

	/**
	 * The edges of the highlighted node, drawn over the others: to the works it
	 * cites in the accent color, from the works citing it in the incoming color.
	 */
	private updateFocusEdges(): void {
		const focus = this.shownFocus;
		const out = focus ? this.links.filter((l) => l.source === focus) : [];
		const into = focus ? this.links.filter((l) => l.target === focus) : [];
		this.focusOutEdges.setLinks(out);
		this.focusInEdges.setLinks(into);
		this.focusCited = new Set(out.map((l) => l.target));
		this.focusCiting = new Set(into.map((l) => l.source));
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
				if (n.data.depth === 0 || shown++ < MAX_NEIGHBOR_LABELS) this.ensureLabel(n);
			}
			this.updateFocusEdges();
		}
		this.requestFrame();
	}

	/** The node under a point of the canvas, if any. */
	/**
	 * What fitting the view must show: the works as drawn, and in the
	 * chronological layout the years above them (enough points along the top
	 * of the axis to survive the extremes `fitCamera` ignores).
	 */
	private fitPoints(): { x?: number; y?: number; radius: number }[] {
		const points: { x?: number; y?: number; radius: number }[] = this.nodes.map((n) => ({ x: n.x, y: n.y, radius: this.drawnRadius(n) }));
		const parts = this.axisParts;
		if (!parts || !this.axisLayer.visible || this.nodes.length === 0) return points;
		const bounds = parts.top.getLocalBounds();
		const top = parts.top.y + bounds.y;
		const count = Math.ceil(this.nodes.length * 0.02) + 2;
		for (let i = 0; i < count; i++) points.push({ x: bounds.x + (bounds.width * i) / (count - 1), y: top, radius: 0 });
		return points;
	}

	/**
	 * A work's radius as drawn: bigger in the chronological layout, which is
	 * seen from far, and times the "Point size" chosen in the panel.
	 */
	private drawnRadius(node: SimNode): number {
		return (this.layoutStyle === 'chronological' ? node.radius * CHRONOLOGICAL_POINT_SCALE : node.radius) * this.pointSize();
	}

	/** The "Point size" chosen (0.25 to 3). */
	private pointSize(): number {
		return Math.min(3, Math.max(0.25, Number(this.settings().graphPointScale) || 1));
	}

	/**
	 * The work under a point of the view. During the idle animation, the works
	 * are looked for where they are drawn, not where the layout has them.
	 */
	private nodeAt(global: { x: number; y: number }): SimNode | null {
		const p = this.world.toLocal(global);
		const scale = this.world.scale.x;
		const idle = this.idle.level > 0 ? this.idle : null;
		// Every node can be hit within a few pixels of its edge, and at least
		// MIN_HIT_RADIUS pixels from its center, however small it is on screen;
		// when several can, the one whose edge is nearest the pointer wins.
		let best: SimNode | null = null;
		let bestGap = Infinity;
		for (const node of this.nodes) {
			if (node.x === undefined || node.y === undefined || this.outOfTime(node)) continue;
			if (idle && (idle.appear[node.index] ?? 1) < 1) continue;
			const x = idle ? (idle.shown[node.index * 2] ?? node.x) : node.x;
			const y = idle ? (idle.shown[node.index * 2 + 1] ?? node.y) : node.y;
			const radius = this.drawnRadius(node) * (idle ? 1 + ((idle.perspectiveScale[node.index] ?? 1) - 1) * idle.level : 1);
			const reach = Math.max(radius + HIT_SLACK / scale, MIN_HIT_RADIUS / scale);
			const d = Math.hypot(x - p.x, y - p.y);
			if (d > reach) continue;
			const gap = d - radius;
			if (gap <= bestGap) {
				best = node;
				bestGap = gap;
			}
		}
		return best;
	}

	private startDrag(node: SimNode, at: { x: number; y: number }): void {
		this.dragged = node;
		this.dragMoved = false;
		this.dragStart = { x: at.x, y: at.y };
	}

	/** What a click on a work opens, in words; null when there is nothing to open. */
	private openAction(node: SimNode): string | null {
		if (node.data.file) return 'Click to open the note';
		if (node.data.doi || node.data.openAlexId || node.data.entry) return 'Click to see its note-to-be';
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
		// Legend of the arrows, in their colors: the works it cites, the works citing it.
		const cites = this.links.filter((l) => l.source === node).length;
		const citedBy = this.links.filter((l) => l.target === node).length;
		const theme = this.theme;
		if (theme && (cites > 0 || citedBy > 0)) {
			hint.appendText(' · ');
			hint.createSpan({ cls: 'literature-graph-view-hint-arrow', text: `→ cites ${cites}` }).setCssProps({
				'--literature-graph-arrow': hexColor(theme.focused.color),
			});
			hint.appendText(' · ');
			hint.createSpan({ cls: 'literature-graph-view-hint-arrow', text: `← cited by ${citedBy}` }).setCssProps({
				'--literature-graph-arrow': hexColor(theme.incoming.color),
			});
		}
		const action = this.openAction(node);
		if (action) hint.createSpan({ cls: 'literature-graph-view-hint-action', text: ` · ${action}` });
	}

	/**
	 * Opens a work: its note; or, for a work outside the vault, its "ghost
	 * note" in a new tab (see `workView.ts`), which becomes a note once written in.
	 */
	private openNode(node: SimNode, event: MouseEvent): void {
		const data = node.data;
		if (data.file) {
			const newTab = event.button === 1 ? 'tab' : Keymap.isModEvent(event);
			void openFileAtLine(this.app, data.file, 0, newTab);
			return;
		}
		const state: WorkState | null = data.entry
			? { entry: { text: data.entry.text, title: data.title, label: data.label, year: data.entry.year } }
			: data.openAlexId || data.doi
				? { id: data.openAlexId, doi: data.doi }
				: null;
		if (state) void this.app.workspace.getLeaf('tab').setViewState({ type: WORK_VIEW, active: true, state: { ...state } });
	}

	/** The user moved the view: the camera stops moving by itself. */
	private takeCamera(): void {
		this.cameraMode = null;
	}

	/**
	 * Pointer interactions, handled on the canvas itself rather than by Pixi's
	 * event system: Pixi listens for moves and releases on the main window's
	 * document, which never sees them when the view is in a pop-out window.
	 * During a drag or a pan the canvas captures the pointer, so the moves and
	 * the release still reach it outside the canvas, in any window.
	 */
	private setUpInteractions(pixi: Application): void {
		const canvas = pixi.canvas;
		pixi.stage.eventMode = 'none';
		/** The pointer's position in the canvas, in the units of `pixi.screen` (CSS pixels). */
		const at = (e: PointerEvent) => {
			const rect = canvas.getBoundingClientRect();
			return { x: e.clientX - rect.left, y: e.clientY - rect.top };
		};

		canvas.addEventListener('pointerdown', (e: PointerEvent) => {
			if (e.button !== 0 && e.button !== 1) return;
			// The click that stops the idle animation only stops it.
			if (this.idle.level > 0) return;
			const p = at(e);
			const node = this.nodeAt(p);
			if (node) this.startDrag(node, p);
			else this.panning = { x: p.x - this.world.x, y: p.y - this.world.y };
			try {
				canvas.setPointerCapture(e.pointerId);
			} catch {
				// The pointer is already gone (released at once): nothing to capture.
			}
			// A middle click would otherwise start the browser's autoscroll.
			if (e.button === 1) e.preventDefault();
		});
		canvas.addEventListener('pointermove', (e: PointerEvent) => {
			const p = at(e);
			if (this.dragged) {
				if (!this.dragMoved && Math.hypot(p.x - this.dragStart.x, p.y - this.dragStart.y) > 3) {
					this.dragMoved = true;
					this.takeCamera();
				}
				if (!this.dragMoved) return;
				// The node follows the pointer at once; the layout moves the others.
				const w = this.world.toLocal(p);
				this.dragged.x = w.x;
				this.dragged.y = w.y;
				this.layout?.send({ type: 'drag', index: this.dragged.index, x: w.x, y: w.y });
				this.edgesDirty = true;
				this.requestFrame();
			} else if (this.panning) {
				this.takeCamera();
				this.zoom = null;
				this.world.position.set(p.x - this.panning.x, p.y - this.panning.y);
				this.requestFrame();
			} else {
				// (During the idle animation too: `nodeAt` then looks where the works are drawn.)
				const node = this.nodeAt(p);
				canvas.style.cursor = node && this.idle.level === 0 && this.openAction(node) ? 'pointer' : '';
				if (node !== this.hovered) this.setHovered(node);
			}
		});
		canvas.addEventListener('pointerleave', () => {
			if (!this.dragged && !this.panning) this.setHovered(null);
		});
		const release = (e: PointerEvent, open: boolean) => {
			const node = this.dragged;
			this.panning = null;
			if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
			if (!node) return;
			this.dragged = null;
			if (this.dragMoved) this.layout?.send({ type: 'release', index: node.index });
			else if (open) this.openNode(node, e);
			this.requestFrame();
		};
		canvas.addEventListener('pointerup', (e: PointerEvent) => release(e, true));
		// A drag cut short (the window lost the pointer): release without opening.
		canvas.addEventListener('pointercancel', (e: PointerEvent) => release(e, false));

		// Zoom around the pointer, smoothly: each wheel step changes the zoom to
		// reach, and the frames move toward it keeping the point under the pointer.
		pixi.canvas.addEventListener(
			'wheel',
			(e: WheelEvent) => {
				e.preventDefault();
				const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
				// The idle animation moves the camera itself: the wheel changes its zoom.
				if (this.idle.level > 0 && framesShape(this.idle.animation)) {
					this.idle.zoom = Math.min(8, Math.max(0.25, this.idle.zoom * Math.exp(-delta * 0.0015)));
					this.requestFrame();
					return;
				}
				this.takeCamera();
				const rect = pixi.canvas.getBoundingClientRect();
				const px = e.clientX - rect.left;
				const py = e.clientY - rect.top;
				const scale = this.world.scale.x;
				const from = this.zoom?.scale ?? scale;
				// (Pixel and line wheels: trackpads send many small pixel steps.)
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
