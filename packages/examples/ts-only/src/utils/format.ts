// Public formatting utilities

export function round(n: number, decimals = 2): number {
  return Math.round(n * 10 ** decimals) / 10 ** decimals
}

export function percent(value: number, total: number): string {
  if (total === 0) return "0%"
  return `${round((value / total) * 100)}%`
}

export function padStart(s: string, len: number, fill = " "): string {
  return s.length >= len ? s : fill.repeat(len - s.length) + s
}
