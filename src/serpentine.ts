import type { Line, Point } from './geometry';
import type { LengthOptions } from './length-planner';
import { copperLength, copperPath } from './copper';
import type { WindowPriority } from './space-priority';
import { padEndOffsets } from './pad-priority';

export type WaveOptions = LengthOptions;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const continuous = (options: LengthOptions) => options.pattern === 'single' || options.pattern === 'double';
export function waveExtraAt(amplitude: number, baseRadius: number, n = 1, pattern = 'single') {
	const corners = pattern === 'double' ? 2 * n + 2 : 4 * n;
	return 2 * n * amplitude + corners * (Math.PI / 2 - 2) * Math.min(baseRadius, amplitude / 2);
}
export function waveCounts(extra: number, options: LengthOptions, width: number): number[] {
	if (options.lobes) return [options.lobes];
	const counts = Array.from({ length: 48 }, (_, i) => i + 1).filter(n => {
		if (options.pattern === 'double' && n < 2) return false;
		const m = waveMetrics(extra, options, width, n);
		return m.amplitude + 1e-8 >= (options.minAmplitude ?? 0) && m.amplitude <= options.amplitude + 1e-8;
	});
	return [...counts.filter(n => n >= 4), ...counts.filter(n => n < 4)];
}
export function waveMetrics(extra: number, options: WaveOptions, width: number, n: number) {
	const baseRadius = (width + options.clearance) / 2;
	const corners = options.pattern === 'double' ? 2 * n + 2 : 4 * n;
	const correction = corners * (Math.PI / 2 - 2);
	const amplitude = extra <= (4 * n + correction) * baseRadius ? extra / (2 * n + correction / 2) : (extra - correction * baseRadius) / (2 * n);
	const radius = Math.min(baseRadius, amplitude / 2), flat = Math.max(0, options.pitch - 2 * radius);
	const span = options.pitch + 2 * radius, period = options.pattern === 'double' ? options.pitch : 2 * options.pitch;
	return { amplitude, radius, flat, span, period, occupied: options.pattern === 'double' ? n * options.pitch + 2 * radius : (n - 1) * period + span };
}
export function* roundedCandidates(line: Line, extra: number, options: WaveOptions, placement = 0, anchor?: Point, priority?: WindowPriority): Generator<Line[]> {
	const length = distance(line.start, line.end), guard = Math.max(line.width + options.clearance, 1);
	const u = { x: (line.end.x - line.start.x) / length, y: (line.end.y - line.start.y) / length };
	const world = (x: number, y: number): Point => ({ x: line.start.x + u.x * x - u.y * y, y: line.start.y + u.y * x + u.x * y });
	const signs = options.side === 'left' ? [1] : options.side === 'right' ? [-1] : [1, -1], positions = [.5, 0, 1, .25, .75];
	for (const n of waveCounts(extra, options, line.width)) {
		const m = waveMetrics(extra, options, line.width, n), r = m.radius, a = m.amplitude;
		if (a + 1e-8 < (options.minAmplitude ?? 0) || a > options.amplitude + 1e-8 || m.occupied > length - 2 * guard + 1e-8) continue;
		const offsets = anchor ? [Math.max(guard, Math.min(length - guard - m.occupied, (anchor.x - line.start.x) * u.x + (anchor.y - line.start.y) * u.y - m.occupied / 2))] : [...positions.slice(placement), ...positions.slice(0, placement)].map(f => guard + (length - 2 * guard - m.occupied) * f);
		const windows = signs.flatMap(sign => [...offsets, ...(!anchor ? padEndOffsets(line, options, guard, m.occupied) : [])].map(offset => ({ sign, offset, score: priority?.(line, offset, m.occupied, options.pattern ?? 'single', sign) ?? 0 }))).filter(w => Number.isFinite(w.score)).sort((a, b) => b.score - a.score);
		for (const { sign, offset } of windows) {
			const path = copperPath(line);
			const point = (x: number, y: number, s: number) => path.point(world(x, y * s));
			const arc = (cx: number, cy: number, from: number, to: number, s: number) => path.arc(world(cx + r * Math.cos(from), s * (cy + r * Math.sin(from))), world(cx + r * Math.cos(to), s * (cy + r * Math.sin(to))), s * (to - from) * 180 / Math.PI);
			for (let i = 0; i < n; i++) {
				const start = offset + i * m.period, s = sign * (options.pattern === 'double' && i % 2 ? -1 : 1);
				if (options.pattern !== 'double' || i === 0) arc(start, r, -Math.PI / 2, 0, s);
				point(start + r, a - r, s);
				arc(start + 2 * r, a - r, Math.PI, Math.PI / 2, s);
				point(start + 2 * r + m.flat, a, s);
				arc(start + 2 * r + m.flat, a - r, Math.PI / 2, 0, s);
				if (options.pattern !== 'double' || i === n - 1) { point(start + 3 * r + m.flat, r, s); arc(start + 4 * r + m.flat, r, Math.PI, 3 * Math.PI / 2, s); }
			}
			path.point(line.end);
			if (path.result.some(l => copperLength(l) < .001)) continue;
			yield path.result;
		}
	}
}
