import type { Line } from './geometry';
import type { LengthOptions, LengthSection, TuningPattern } from './length-planner';
import type { Route } from './routes';
import type { Steps } from './work';
import type { AmplitudeProfile } from './adaptive';
import { copperLength } from './copper';

interface Slot { source: Line; line: Line }
interface MixedTools {
	candidates: (line: Line, extra: number, options: LengthOptions, placement: number) => Generator<Line[]>;
	capacity: (line: Line, options: LengthOptions) => number;
	check: (candidate: Line[], original: Line, peers: Line[]) => string | undefined;
	adaptive?: (line: Line, extra: number, options: LengthOptions, peers: Line[]) => Steps<AmplitudeProfile | undefined>;
	priority?: (line: Line) => number;
	allowLarge?: boolean;
}
const length = copperLength;

// Bounded backtracking across independent tuning windows. Every accepted window
// is checked against both earlier windows and untouched future copper.
export function* fitMixedSteps(route: Route, delta: number, options: LengthOptions, tools: MixedTools, placement: number): Steps<{ lines: Line[]; sections: LengthSection[] }> {
	const patterns: TuningPattern[] = tools.allowLarge === false ? ['single', 'double'] : ['single', 'double', 'large'];
	let reason = '可用空间或振幅约束不足';
	const styleOptions = (pattern: TuningPattern): LengthOptions => ({ ...options, pattern, lobes: 0 });
	const styleOrder = (depth: number) => patterns.map((_, i) => patterns[(placement + depth + i) % patterns.length]);
	const compare = (a: Line, b: Line) => (tools.priority?.(b) ?? 0) - (tools.priority?.(a) ?? 0) || length(b) - length(a);
	const ordered = [...route.lines].sort(compare).slice(0, 32);
	// Keep a simple solution when one form can satisfy the whole increment.
	for (const pattern of styleOrder(0)) for (const source of ordered) {
		const adaptive = tools.adaptive ? yield* tools.adaptive(source, delta, styleOptions(pattern), route.lines.filter(l => l.id !== source.id)) : undefined;
		if (adaptive) return { lines: route.lines.flatMap(l => l.id === source.id ? adaptive.lines : [l]), sections: [{ sourceId: source.id, pattern, added: delta, start: source.start, end: source.end, amplitudes: adaptive.amplitudes }] };
		for (const candidate of tools.candidates(source, delta, styleOptions(pattern), placement)) {
			yield;
			const blocked = tools.check(candidate, source, route.lines.filter(l => l.id !== source.id));
			if (blocked) { reason = blocked; continue; }
			return { lines: route.lines.flatMap(l => l.id === source.id ? candidate : [l]), sections: [{ sourceId: source.id, pattern, added: delta, start: source.start, end: source.end }] };
		}
	}
	for (const split of [1, 2, 3, 4]) {
		const slots: Slot[] = route.lines.flatMap(source => {
			const guard = Math.max(source.width + options.clearance, 1);
			const count = Math.min(split, Math.max(1, Math.floor(length(source) / (2 * guard + options.pitch + 2))));
			const at = (t: number) => ({ x: source.start.x + (source.end.x - source.start.x) * t, y: source.start.y + (source.end.y - source.start.y) * t });
			return Array.from({ length: count }, (_, i) => ({ source, line: { ...source, id: `${source.id}/mixed/${i}`, start: at(i / count), end: at((i + 1) / count) } }));
		});
		const jobs = [...slots].sort((a, b) => compare(a.line, b.line)).slice(0, 32);
		const geometry = new Map(slots.map(s => [s.line.id, [s.line]]));
		const caps = jobs.map(s => new Map(patterns.map(pattern => [pattern, tools.capacity(s.line, styleOptions(pattern))])));
		const suffix = new Array<number>(jobs.length + 1).fill(0);
		for (let i = jobs.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + Math.max(...caps[i].values());
		let budget = 600;
		const sections: LengthSection[] = [];
		function* search(index: number, remaining: number): Steps<boolean> {
			if (remaining <= options.tolerance) return true;
			if (index >= jobs.length || remaining > suffix[index] + options.tolerance || budget <= 0) return false;
			const slot = jobs[index];
			for (const pattern of styleOrder(index)) {
				const max = Math.min(remaining, caps[index].get(pattern)!);
				if (max <= options.tolerance) continue;
				const amounts = [max, Math.min(max, remaining / (jobs.length - index)), ...[0.75, 0.5, 0.25, 0.125].map(r => max * r)];
				const seen = new Set<string>();
				for (const amount of amounts) {
					if (amount <= options.tolerance || remaining - amount > suffix[index + 1] + options.tolerance || seen.has(amount.toFixed(7))) continue;
					seen.add(amount.toFixed(7));
					const peers = slots.filter(s => s.line.id !== slot.line.id).flatMap(s => geometry.get(s.line.id)!);
					const adaptive = tools.adaptive ? yield* tools.adaptive(slot.line, amount, styleOptions(pattern), peers) : undefined;
					function* candidates() { if (adaptive) yield adaptive.lines; yield* tools.candidates(slot.line, amount, styleOptions(pattern), placement); }
					for (const candidate of candidates()) {
						if (--budget < 0) return false;
						yield;
						const blocked = tools.check(candidate, slot.line, peers);
						if (blocked) { reason = blocked; continue; }
						geometry.set(slot.line.id, candidate);
						sections.push({ sourceId: slot.source.id, pattern, added: amount, start: slot.line.start, end: slot.line.end, ...(candidate === adaptive?.lines ? { amplitudes: adaptive.amplitudes } : {}) });
						if (yield* search(index + 1, remaining - amount)) return true;
						sections.pop(); geometry.set(slot.line.id, [slot.line]);
					}
				}
			}
			// A constrained window may be left unchanged; later windows can tune.
			if (--budget < 0) return false;
			yield;
			return yield* search(index + 1, remaining);
		}
		if (yield* search(0, delta)) {
			const result = route.lines.flatMap(source => {
				if (!sections.some(s => s.sourceId === source.id)) return [source];
				const all = slots.filter(s => s.source.id === source.id).flatMap(s => geometry.get(s.line.id)!);
				return all.map((l, i) => ({ ...l, id: i ? `${source.id}/length/${i}` : source.id }));
			});
			return { lines: result, sections };
		}
		yield '正在搜索单边、双边与大折返的组合…';
	}
	throw new Error(`${route.net} 混合补长未找到可行组合（${reason}）。可调整间距、振幅、方向或目标长度；组合搜索有数量上限`);
}
