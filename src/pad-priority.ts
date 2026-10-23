import type { Line, Point } from './geometry';
import type { Obstacle, Route } from './routes';
import type { LengthOptions } from './length-planner';
import { contains, dist } from './routes';
import { copperLength } from './copper';

// A symbol keeps this planning-only context out of storage and panel parameters.
export const PAD_PRIORITY = Symbol('pad-priority');
export interface PadPriority { endsOnly: boolean; distance: (line: Line, offset: number, span: number) => number }
export type PadOptions = LengthOptions & { [PAD_PRIORITY]?: PadPriority };
export function padEndOffsets(line: Line, options: LengthOptions, guard: number, span: number): number[] {
	if (!(options as PadOptions)[PAD_PRIORITY]) return [];
	const high = copperLength(line) - guard - span;
	return [options.pitch, 2 * options.pitch].flatMap(step => [guard + step, high - step]).filter(offset => offset >= guard && offset <= high);
}
const root = (id: string) => id.split('/length/')[0].split('/mixed/')[0];

/** Multi-source shortest copper distance to actual pads. Vias are not pad seeds;
 * cross-layer links are admitted only from already verified chosen paths. */
export function createPadPriority(lines: Line[], chosen: Route[], obstacles: Obstacle[]): PadPriority | undefined {
	const pads = obstacles.filter(o => o.pad && o.net);
	if (!pads.length) return undefined;
	const nodes = new Map<string, number>(), edges: { to: number; cost: number }[][] = [], costs: number[] = [];
	const node = (l: Line, p: Point) => {
		const key = `${l.net}/${l.layer}/${p.x.toFixed(3)}/${p.y.toFixed(3)}`;
		let id = nodes.get(key);
		if (id === undefined) { id = edges.length; nodes.set(key, id); edges.push([]); costs.push(Infinity); }
		return id;
	};
	const link = (a: number, b: number, cost: number) => { edges[a].push({ to: b, cost }); edges[b].push({ to: a, cost }); };
	const sources = new Map<string, { line: Line; a: number; b: number; length: number }>();
	const heap: { id: number; cost: number }[] = [];
	const push = (id: number, cost: number) => {
		if (cost >= costs[id]) return;
		costs[id] = cost; let i = heap.length; heap.push({ id, cost });
		while (i) { const p = (i - 1) >> 1; if (heap[p].cost <= cost) break; heap[i] = heap[p]; i = p; } heap[i] = { id, cost };
	};
	for (const line of lines) {
		const a = node(line, line.start), b = node(line, line.end), length = copperLength(line);
		link(a, b, length); sources.set(line.id, { line, a, b, length });
		for (const pad of pads) if (pad.net === line.net && (pad.layer === line.layer || pad.layer === 12)) {
			if (contains(pad.box, line.start, line.width / 2)) push(a, 0);
			if (contains(pad.box, line.end, line.width / 2)) push(b, 0);
		}
	}
	for (const route of chosen) for (let i = 1; i < route.lines.length; i++) {
		const a = route.lines[i - 1], b = route.lines[i];
		if (a.layer === b.layer || a.net !== b.net) continue;
		for (const p of [a.start, a.end]) for (const q of [b.start, b.end]) if (dist(p, q) <= .001) link(node(a, p), node(b, q), 0);
	}
	while (heap.length) {
		const first = heap[0], last = heap.pop()!;
		if (heap.length) {
			let i = 0;
			while (2 * i + 1 < heap.length) {
				let child = 2 * i + 1;
				if (child + 1 < heap.length && heap[child + 1].cost < heap[child].cost) child++;
				if (heap[child].cost >= last.cost) break;
				heap[i] = heap[child]; i = child;
			} heap[i] = last;
		}
		if (first.cost !== costs[first.id]) continue;
		for (const e of edges[first.id]) push(e.to, first.cost + e.cost);
	}
	if (!chosen.some(r => r.lines.some(l => { const s = sources.get(l.id); return s && Number.isFinite(Math.min(costs[s.a], costs[s.b])); }))) return undefined;
	return { endsOnly: false, distance: (line, offset, span) => {
		const source = sources.get(root(line.id)); if (!source) return Infinity;
		const length = copperLength(line), ux = (line.end.x - line.start.x) / length, uy = (line.end.y - line.start.y) / length;
		const original = source.line, dx = original.end.x - original.start.x, dy = original.end.y - original.start.y;
		return Math.min(...[offset, offset + span].map(t => {
			const p = { x: line.start.x + ux * t, y: line.start.y + uy * t };
			const f = Math.max(0, Math.min(1, ((p.x - original.start.x) * dx + (p.y - original.start.y) * dy) / (dx * dx + dy * dy)));
			const shift = dist(p, { x: original.start.x + dx * f, y: original.start.y + dy * f });
			return Math.min(costs[source.a] + f * source.length, costs[source.b] + (1 - f) * source.length) + shift;
		}));
	} };
}
