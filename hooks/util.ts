// A usable count: a number that is not NaN or infinite, else 0
export function num(x: unknown): number {
  return typeof x === 'number' && isFinite(x) ? x : 0
}

export function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export const parseJson = (text: unknown): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(String(text))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}
