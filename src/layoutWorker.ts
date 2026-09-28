/**
 * Entry point of the layout's web worker, bundled on its own by esbuild and
 * embedded in main.js as text (see esbuild.config.mjs and `layoutRunner.ts`).
 */
import { LayoutLoop, LayoutMessage } from './layout';

const scope = self as unknown as {
	postMessage(message: unknown, transfer: Transferable[]): void;
	onmessage: ((event: MessageEvent<LayoutMessage>) => void) | null;
	setTimeout(fn: () => void, ms: number): number;
	clearTimeout(id: number): void;
};

const loop = new LayoutLoop((update) => scope.postMessage(update, [update.positions.buffer]), {
	setTimeout: (fn, ms) => scope.setTimeout(fn, ms),
	clearTimeout: (id) => scope.clearTimeout(id),
	now: () => performance.now(),
});

scope.onmessage = (event) => loop.handle(event.data);
