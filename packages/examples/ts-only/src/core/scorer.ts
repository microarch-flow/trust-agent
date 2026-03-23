// Proprietary scoring logic — SECRET
const WEIGHT_A = 0.62
const WEIGHT_B = 0.38
const INTERNAL_THRESHOLD = 0.71

export class Scorer {
  score(features: number[]): number {
    if (features.length === 0) return 0
    const weighted =
      features[0] * WEIGHT_A + (features[1] ?? 0) * WEIGHT_B
    return weighted > INTERNAL_THRESHOLD ? weighted : 0
  }

  batch(inputs: number[][]): number[] {
    return inputs.map((f) => this.score(f))
  }
}
