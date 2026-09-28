/**
 * Which labels of the graph to show: when labels would cover one another,
 * only the most important one is shown, so the others stay readable.
 */

/** A label's box on screen, in pixels, and how much it matters (higher first). */
export interface LabelBox {
	x: number;
	y: number;
	width: number;
	height: number;
	priority: number;
}

/** Size of the grid cells used to find neighboring labels, in pixels. */
const CELL = 64;
/** Labels may touch by this much (pixels) before one is hidden. */
const TOLERANCE = 2;

/**
 * Places the labels from the most to the least important, skipping each one
 * that would cover a label already placed. Returns, for each label (in the
 * given order), whether it is shown.
 */
export function placeLabels(boxes: readonly LabelBox[]): boolean[] {
	const shown = boxes.map(() => false);
	const order = boxes.map((_, i) => i).sort((a, b) => (boxes[b]?.priority ?? 0) - (boxes[a]?.priority ?? 0));
	const grid = new Map<string, LabelBox[]>();
	const cells = (b: LabelBox, visit: (key: string) => boolean | void): boolean => {
		const x0 = Math.floor(b.x / CELL);
		const x1 = Math.floor((b.x + b.width) / CELL);
		const y0 = Math.floor(b.y / CELL);
		const y1 = Math.floor((b.y + b.height) / CELL);
		for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) if (visit(`${cx},${cy}`)) return true;
		return false;
	};
	const overlaps = (a: LabelBox, b: LabelBox) =>
		a.x + TOLERANCE < b.x + b.width &&
		b.x + TOLERANCE < a.x + a.width &&
		a.y + TOLERANCE < b.y + b.height &&
		b.y + TOLERANCE < a.y + a.height;
	for (const i of order) {
		const box = boxes[i];
		if (!box) continue;
		const blocked = cells(box, (key) => (grid.get(key) ?? []).some((other) => overlaps(box, other)));
		if (blocked) continue;
		shown[i] = true;
		cells(box, (key) => {
			const list = grid.get(key);
			if (list) list.push(box);
			else grid.set(key, [box]);
		});
	}
	return shown;
}
