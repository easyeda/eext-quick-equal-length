export type Progress = (message: string) => void | Promise<void>;
export type Steps<T> = Generator<string | undefined, T, unknown>;

let serial = 0;
// Multiple bridge evaluations / extension instances must not replace each
// other's pending cooperative callback when their local serials both start at 0.
const instance = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function yieldEditor(): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!eda.sys_Timer.setTimeoutTimer(`track-length-yield-${instance}-${serial++}`, 0, resolve))
			reject(new Error('无法安排分步计算，未继续写入'));
	});
}

export function finish<T>(steps: Steps<T>): T {
	let next = steps.next();
	while (!next.done)
		next = steps.next();
	return next.value;
}

export async function runCooperatively<T>(steps: Steps<T>, progress?: Progress): Promise<T> {
	let lastMessage = '';
	let pendingMessage = '', publishedAt = 0;
	await yieldEditor();
	let start = Date.now();
	while (true) {
		const next = steps.next();
		if (next.done) {
			if (pendingMessage && pendingMessage !== lastMessage) await progress?.(pendingMessage);
			return next.value;
		}
		if (next.value) pendingMessage = next.value;
		if (pendingMessage !== lastMessage && Date.now() - publishedAt >= 150) {
			lastMessage = pendingMessage; publishedAt = Date.now();
			await progress?.(lastMessage);
		}
		if (Date.now() - start >= 16) {
			await yieldEditor();
			start = Date.now();
		}
	}
}
