/** Colors as numbers (0xrrggbb), as PixiJS takes them. */

/** The color between `a` and `b`: `t` = 0 gives `a`, 1 gives `b`. */
export function mixColor(a: number, b: number, t: number): number {
	const channel = (shift: number) => {
		const x = (a >> shift) & 0xff;
		const y = (b >> shift) & 0xff;
		return Math.round(x + (y - x) * t) << shift;
	};
	return channel(16) | channel(8) | channel(0);
}

/** "#rrggbb" for a color number. */
export function hexColor(color: number): string {
	return `#${color.toString(16).padStart(6, '0')}`;
}
