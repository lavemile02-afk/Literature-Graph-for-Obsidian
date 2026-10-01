/**
 * The view's camera: which part of the graph is shown, and how it moves
 * smoothly to a new place (to fit the graph, or to center a note).
 */

/** What the camera shows: the point of the graph at the middle of the screen, and the zoom. */
export interface Camera {
	x: number;
	y: number;
	scale: number;
}

export const MIN_SCALE = 0.005;
export const MAX_SCALE = 6;

export function clampScale(scale: number): number {
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * The camera that shows every node, with a margin. A few far outliers (works
 * pushed away by the layout) are ignored so they do not shrink everything
 * else: the box keeps the nodes between the 1st and 99th percentiles when
 * there are many.
 */
export function fitCamera(
	nodes: readonly { x?: number; y?: number; radius: number }[],
	width: number,
	height: number,
	maxScale = 2,
): Camera | null {
	if (nodes.length === 0 || width <= 0 || height <= 0) return null;
	const xs = nodes.map((n) => n.x ?? 0).sort((a, b) => a - b);
	const ys = nodes.map((n) => n.y ?? 0).sort((a, b) => a - b);
	const cut = nodes.length >= 200 ? Math.floor(nodes.length * 0.01) : 0;
	const last = nodes.length - 1 - cut;
	const pad = Math.max(...nodes.map((n) => n.radius)) + 20;
	const minX = (xs[cut] ?? 0) - pad;
	const maxX = (xs[last] ?? 0) + pad;
	const minY = (ys[cut] ?? 0) - pad;
	const maxY = (ys[last] ?? 0) + pad;
	const scale = clampScale(Math.min(maxScale, (width * 0.92) / (maxX - minX), (height * 0.92) / (maxY - minY)));
	return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale };
}

/**
 * One step of a smooth move from `from` toward `to`: the zoom moves on a
 * logarithmic scale, so zooming in and out feel the same. Returns the target
 * itself once close enough.
 */
export function approach(from: Camera, to: Camera, amount: number): Camera {
	const logFrom = Math.log(from.scale);
	const logTo = Math.log(to.scale);
	const scale = Math.exp(logFrom + (logTo - logFrom) * amount);
	const x = from.x + (to.x - from.x) * amount;
	const y = from.y + (to.y - from.y) * amount;
	const done = Math.abs(logTo - logFrom) < 0.002 && Math.hypot(to.x - x, to.y - y) * scale < 0.5;
	return done ? { ...to } : { x, y, scale };
}
