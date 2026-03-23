// Public utilities
export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), hi)

export const round = (n: number, d = 2) =>
  Math.round(n * 10 ** d) / 10 ** d
