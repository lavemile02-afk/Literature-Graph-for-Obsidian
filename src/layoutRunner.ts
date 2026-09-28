import workerCode from 'layout-worker:code';
import { LayoutLoop, LayoutMessage, LayoutUpdate } from './layout';

/**
 * Runs the graph's layout in a web worker, or in Obsidian itself when a
 * worker cannot be started; either way, positions come back through
 * `onUpdate`.
 */
export class LayoutRunner {
	private worker: Worker | null = null;
	private loop: LayoutLoop | null = null;
	private url: string | null = null;

	constructor(win: Window, onUpdate: (update: LayoutUpdate) => void) {
		try {
			this.url = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
			const worker = new Worker(this.url);
			worker.onmessage = (event: MessageEvent<LayoutUpdate>) => onUpdate(event.data);
			worker.onerror = (event) => {
				// The worker failed (it could not load, for example): go on without it.
				event.preventDefault();
				console.warn('Literature Graph.md: the layout worker failed; the layout runs in Obsidian instead.', event.message);
				this.fallBack(win, onUpdate);
			};
			this.worker = worker;
		} catch {
			this.fallBack(win, onUpdate);
		}
	}

	/** Whether the layout runs in a worker (for tests and diagnostics). */
	get inWorker(): boolean {
		return this.worker !== null;
	}

	private lastStart: LayoutMessage | null = null;

	private fallBack(win: Window, onUpdate: (update: LayoutUpdate) => void): void {
		this.terminateWorker();
		this.loop = new LayoutLoop(onUpdate, {
			setTimeout: (fn, ms) => win.setTimeout(fn, ms),
			clearTimeout: (id) => win.clearTimeout(id),
			now: () => win.performance.now(),
		});
		// Start again in Obsidian what the worker was running.
		if (this.lastStart) this.loop.handle(this.lastStart);
	}

	send(message: LayoutMessage): void {
		if (message.type === 'start') this.lastStart = message;
		if (this.worker) this.worker.postMessage(message);
		else this.loop?.handle(message);
	}

	private terminateWorker(): void {
		this.worker?.terminate();
		this.worker = null;
		if (this.url) URL.revokeObjectURL(this.url);
		this.url = null;
	}

	destroy(): void {
		this.loop?.handle({ type: 'stop' });
		this.loop = null;
		this.terminateWorker();
	}
}
