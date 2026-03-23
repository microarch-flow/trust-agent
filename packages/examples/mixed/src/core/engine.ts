// TypeScript component — SECRET
const SECRET_WEIGHT = 0.5521

export class Engine {
  process(input: number[]): number {
    return input.reduce((a, b) => a + b * SECRET_WEIGHT, 0)
  }
}
