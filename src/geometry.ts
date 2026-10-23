export interface Point { x: number; y: number }
export interface Line {
	/** Nonzero signed sweep in degrees denotes a native copper ARC. */
	arcAngle?: number;
	interactiveMode?: number;
	id: string;
	layer: number;
	net: string;
	width: number;
	locked: boolean;
	start: Point;
	end: Point;
}
export interface Arrangement {
	ordered: Line[];
	normal: Point;
	offsets: number[];
	gaps: number[];
}

export const POSITION_TOLERANCE = 0.001;

export function analyze(lines: Line[]): Arrangement {
	if (lines.length < 2)
		throw new Error('请在画布选中至少两条平行直线');
	const reference = lines[0];
	const dx = reference.end.x - reference.start.x;
	const dy = reference.end.y - reference.start.y;
	const length = Math.hypot(dx, dy);
	if (length < 1e-6)
		throw new Error('选中集包含零长度线段');
	const tangent = { x: dx / length, y: dy / length };
	let normal = { x: -tangent.y, y: tangent.x };
	if (normal.y < -1e-9 || (Math.abs(normal.y) <= 1e-9 && normal.x < 0))
		normal = { x: -normal.x, y: -normal.y };
	for (const line of lines) {
		if (![line.start.x, line.start.y, line.end.x, line.end.y, line.width].every(Number.isFinite))
			throw new Error('线段数据异常，请重新读取');
		if (line.locked)
			throw new Error('包含锁定线段，请先解锁');
		if (line.layer !== reference.layer)
			throw new Error('请选中同一图层的平行直线');
		const vx = line.end.x - line.start.x;
		const vy = line.end.y - line.start.y;
		if (Math.hypot(vx, vy) < 1e-6)
			throw new Error('选中集包含零长度线段');
		// Endpoint rounding may add tiny skew, but materially nonparallel lines are rejected.
		if (Math.abs(vx * tangent.y - vy * tangent.x) > POSITION_TOLERANCE)
			throw new Error('所选直线不平行，请重新选择');
	}
	const offset = (l: Line) => (l.start.x + l.end.x) / 2 * normal.x + (l.start.y + l.end.y) / 2 * normal.y;
	const ordered = [...lines].sort((a, b) => offset(a) - offset(b) || a.id.localeCompare(b.id));
	const offsets = ordered.map(offset);
	const gaps = offsets.slice(1).map((value, i) => value - offsets[i]);
	return { ordered, normal, offsets, gaps };
}

export function planSpacing(lines: Line[], spacing: number) {
	if (!Number.isFinite(spacing) || spacing <= 0)
		throw new Error('间距必须大于 0');
	const arrangement = analyze(lines);
	return arrangement.ordered.map((before, i) => {
		const distance = arrangement.offsets[0] + i * spacing - arrangement.offsets[i];
		const shift = { x: arrangement.normal.x * distance, y: arrangement.normal.y * distance };
		const after: Line = {
			...before,
			start: { x: before.start.x + shift.x, y: before.start.y + shift.y },
			end: { x: before.end.x + shift.x, y: before.end.y + shift.y },
		};
		if (![after.start.x, after.start.y, after.end.x, after.end.y].every(Number.isFinite))
			throw new Error('目标坐标超出可计算范围');
		return { before, after, moved: Math.abs(distance) > 1e-7 };
	});
}

export function equalLine(a: Line, b: Line, tolerance = 1e-7): boolean {
	return a.id === b.id && a.layer === b.layer && a.net === b.net && a.width === b.width && a.locked === b.locked && (a.arcAngle ?? 0) === (b.arcAngle ?? 0)
		&& Math.abs(a.start.x - b.start.x) <= tolerance && Math.abs(a.start.y - b.start.y) <= tolerance
		&& Math.abs(a.end.x - b.end.x) <= tolerance && Math.abs(a.end.y - b.end.y) <= tolerance;
}

// Native copper processing may change primitive IDs or reverse endpoints.
export function sameLineGeometry(a: Line, b: Line, tolerance = POSITION_TOLERANCE): boolean {
	const near = (p: Point, q: Point) => Math.abs(p.x - q.x) <= tolerance && Math.abs(p.y - q.y) <= tolerance;
	return a.layer === b.layer && a.net === b.net && Math.abs(a.width - b.width) <= tolerance && a.locked === b.locked
		&& ((near(a.start, b.start) && near(a.end, b.end) && Math.abs((a.arcAngle ?? 0) - (b.arcAngle ?? 0)) <= tolerance) || (near(a.start, b.end) && near(a.end, b.start) && Math.abs((a.arcAngle ?? 0) + (b.arcAngle ?? 0)) <= tolerance));
}
