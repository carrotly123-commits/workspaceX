export type ProbeRecord = Record<string, unknown>;

export function record(value: unknown): ProbeRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ProbeRecord : {};
}

export function firstBool(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (/^(true|yes|1)$/i.test(value)) return true;
      if (/^(false|no|0)$/i.test(value)) return false;
    }
  }
  return undefined;
}

export function firstNumber(...values: unknown[]) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function statusIn(expected: string[], ...values: unknown[]) {
  const set = new Set(expected.map((value) => value.toLowerCase()));
  let sawValue = false;
  for (const value of values) {
    const normalized = firstText(value).toLowerCase();
    if (!normalized) continue;
    sawValue = true;
    if (set.has(normalized)) return true;
  }
  return sawValue ? false : undefined;
}

export function compactJoin(values: string[], separator: string) {
  return values.map((value) => value.trim()).filter(Boolean).join(separator);
}

export function extraValues(primary: string, ...values: string[]) {
  const normalizedPrimary = primary.trim().toLowerCase();
  const seen = new Set<string>();
  return values.map((value) => value.trim()).filter((value) => {
    const normalized = value.toLowerCase();
    if (!value || normalized === normalizedPrimary || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}
