import type { Line, Point } from './geometry';
import type { LengthOptions, TuningPattern } from './length-planner';
import type { Steps } from './work';
import { copperLength, copperPath } from './copper';
import type { WindowPriority } from './space-priority';

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export interface AmplitudeProfile { lines: Line[]; amplitudes: number[] }

// Fixed arm positions preserve W while each crest gets its own height/radius.
// Double-sided crests share a straight transverse arm across the baseline.
export function profileGeometry(line: Line, amplitudes: number[], options: LengthOptions, firstArm: number, sign: number, probe = false): Line[] {
	const length = distance(line.start, line.end), base = (line.width + options.clearance) / 2;
	const u = { x: (line.end.x - line.start.x) / length, y: (line.end.y - line.start.y) / length };
	const world = (x: number, y: number): Point => ({ x: line.start.x + u.x * x - u.y * y, y: line.start.y + u.y * x + u.x * y });
	const path = copperPath(line, probe ? world(firstArm, 0) : line.start);
	const point = (x: number, y: number, s: number) => path.point(world(x, s * y));
	const arc = (cx: number, cy: number, radius: number, from: number, to: number, s: number) => path.arc(world(cx + radius * Math.cos(from), s * (cy + radius * Math.sin(from))), world(cx + radius * Math.cos(to), s * (cy + radius * Math.sin(to))), s * (to - from) * 180 / Math.PI);
	for (let i = 0; i < amplitudes.length; i++) {
		const a = amplitudes[i], r = Math.min(base, a / 2), w = options.pitch;
		const s = sign * (options.pattern === 'double' && i % 2 ? -1 : 1);
		const arm = firstArm + i * (options.pattern === 'double' ? w : options.pattern === 'large' ? 2 * w + 2 * base : 2 * w);
		if (options.pattern === 'large') {
			for (const [x, y] of [[arm - r, 0], [arm, r], [arm, a - r], [arm + r, a], [arm + w - r, a], [arm + w, a - r], [arm + w, r], [arm + w + r, 0]]) point(x, y, s);
			continue;
		}
		if (probe) point(arm, 0, s);
		else if (options.pattern !== 'double' || i === 0) arc(arm - r, r, r, -Math.PI / 2, 0, s);
		point(arm, a - r, s);
		arc(arm + r, a - r, r, Math.PI, Math.PI / 2, s);
		point(arm + w - r, a, s);
		arc(arm + w - r, a - r, r, Math.PI / 2, 0, s);
		if (probe) point(arm + w, 0, s);
		else if (options.pattern !== 'double' || i === amplitudes.length - 1) {
			point(arm + w, r, s);
			arc(arm + w + r, r, r, Math.PI, 3 * Math.PI / 2, s);
		}
	}
	if (!probe) path.point(line.end);
	return path.result;
}

export function profileExtra(amplitudes: number[], options: LengthOptions, width: number): number {
	const base = (width + options.clearance) / 2, n = amplitudes.length;
	return amplitudes.reduce((sum, a, i) => {
		const r = Math.min(base, a / 2);
		const weight = options.pattern === 'double' ? n === 1 ? 4 : i === 0 || i === n - 1 ? 3 : 2 : 4;
		return sum + 2 * a + (options.pattern === 'large' ? 4 * Math.SQRT2 - 8 : weight * (Math.PI / 2 - 2)) * r;
	}, 0);
}

export function* fitAdaptiveLineSteps(line: Line, extra: number, options: LengthOptions, check: (candidate: Line[], probe?: boolean) => string | undefined, placement = 0, forcedCounts?: number[], anchor?: Point, priority?: WindowPriority): Steps<AmplitudeProfile | undefined> {
	const pattern = options.pattern as TuningPattern;
	if (!['single', 'double', 'large'].includes(pattern)) return undefined;
	const length = distance(line.start, line.end), base = (line.width + options.clearance) / 2;
	const guard = Math.max(line.width / 2 + options.clearance, 1), w = options.pitch;
	const minimum = Math.max(.2, pattern === 'large' ? 0 : options.minAmplitude ?? 0);
	const counts = forcedCounts ?? (options.lobes && pattern !== 'large' ? [options.lobes] : [...Array.from({ length: 45 }, (_, i) => i + 4), 1, 2, 3]);
	const signs = options.side === 'left' ? [1] : options.side === 'right' ? [-1] : [1, -1];
	const cache = new Map<string, number>();
	for (const n of counts) {
		if (pattern === 'double' && n < 2) continue;
		const span = (pattern === 'double' ? n * w : pattern === 'large' ? n * (w + 2 * base) + (n - 1) * w : (2 * n - 1) * w) + (pattern === 'large' ? 0 : 2 * base);
		const room = length - 2 * guard - span;
		if (room < -1e-8 || profileExtra(new Array(n).fill(minimum), options, line.width) > extra + 1e-8 || profileExtra(new Array(n).fill(options.amplitude), options, line.width) < extra - 1e-8) continue;
		const fractions = [.5, 0, 1, .25, .75];
		const divisions = Math.min(25, Math.ceil(room / Math.max(w / 2, 1)));
		const positions = [...fractions.slice(placement), ...fractions.slice(0, placement), ...Array.from({ length: divisions }, (_, i) => (i + 1) / (divisions + 1))];
		const u = { x: (line.end.x - line.start.x) / length, y: (line.end.y - line.start.y) / length };
		const centered = anchor ? (anchor.x - line.start.x) * u.x + (anchor.y - line.start.y) * u.y - span / 2 - guard : 0;
		const shifts = [0, line.width + options.clearance, -line.width - options.clearance, 2 * (line.width + options.clearance), -2 * (line.width + options.clearance)];
		const offsets = anchor ? shifts.map(d => guard + Math.max(0, Math.min(room, centered + d))) : positions.map(f => guard + Math.max(0, room) * f);
		const used = new Set<string>();
		const windows = offsets.flatMap(offset => signs.map(sign => ({ offset, sign, score: priority?.(line, offset, span, pattern, sign) ?? 0 }))).filter(w => Number.isFinite(w.score)).sort((a, b) => b.score - a.score);
		for (const { offset, sign } of windows) {
			const first = offset + base;
			const key = `${first.toFixed(4)}/${sign}`;
			if (used.has(key)) continue;
			used.add(key);
			const caps: number[] = [];
			for (let i = 0; i < n; i++) {
				const arm = first + i * (pattern === 'double' ? w : pattern === 'large' ? 2 * w + 2 * base : 2 * w);
				const direction = sign * (pattern === 'double' && i % 2 ? -1 : 1), capKey = `${arm.toFixed(4)}/${direction}`;
				let cap = cache.get(capKey);
				if (cap === undefined) {
					let lo = 0, hi = options.amplitude;
					const one = { ...options, pattern: pattern === 'double' ? 'single' as const : pattern };
					for (let k = 0; k < 13; k++) {
						const a = k ? (lo + hi) / 2 : hi;
						const blocked = check(profileGeometry(line, [a], one, arm, direction, true), true);
						yield;
						if (blocked) hi = a; else { lo = a; if (!k) break; }
					}
					cap = lo; cache.set(capKey, cap);
				}
				if (cap < minimum) break;
				caps.push(cap);
			}
			if (caps.length !== n) continue;
			// Smooth sudden openings while staying below every measured envelope.
			const slope = Math.max(w, options.amplitude / n);
			// Opposite sides have independent space; smooth consecutive crests on
			// the same side rather than clipping an open side to its blocked peer.
			const stride = pattern === 'double' ? 2 : 1;
			for (let i = stride; i < n; i++) caps[i] = Math.min(caps[i], caps[i - stride] + slope);
			for (let i = n - 1 - stride; i >= 0; i--) caps[i] = Math.min(caps[i], caps[i + stride] + slope);
			if (profileExtra(caps, options, line.width) < extra - 1e-8) continue;
			let lo = 0, hi = 1;
			for (let k = 0; k < 50; k++) {
				const t = (lo + hi) / 2;
				const amps = caps.map(cap => minimum + t * (cap - minimum));
				if (profileExtra(amps, options, line.width) < extra) lo = t; else hi = t;
			}
			const amplitudes = caps.map(cap => minimum + (lo + hi) / 2 * (cap - minimum));
			const lines = profileGeometry(line, amplitudes, options, first, sign);
			if (Math.abs(lines.reduce((n, l) => n + copperLength(l), 0) - length - extra) > options.tolerance) continue;
			if (lines.some(l => copperLength(l) < .001) || lines.length > 4096) continue;
			yield;
			if (!check(lines)) return { lines, amplitudes };
		}
	}
	return undefined;
}


