export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isOneOf<const T extends readonly unknown[]>(value: unknown, allowed: T): value is T[number] {
  return allowed.includes(value);
}
