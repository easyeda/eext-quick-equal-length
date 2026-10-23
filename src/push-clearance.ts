import type { Line } from './geometry';
// The length panel currently supplies an explicit numeric clearance in mil.
// Keep the reference push kernel's interface without importing its rule reader.
export type RuleObject = 'Track' | 'SMD Pad' | 'TH Pad' | 'Via' | 'Fill Region/Teardrop' | 'Slot Region' | 'Board Outline';
export type Clearance = number;
export const clearanceStep = (value: Clearance) => value;
export const clearanceGap = (value: Clearance, _line: Line, _other: { net: string }, _object: RuleObject = 'Track') => value;
