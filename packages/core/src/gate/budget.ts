import type { ProjectionLevel, PolicySettings } from "../types"

export type BudgetEntry = {
  filePath: string
  totalTokens: number
  askCount: number
  currentLevel: ProjectionLevel
}

export class InfoBudgetTracker {
  private entries = new Map<string, BudgetEntry>()
  private settings: PolicySettings

  constructor(settings: PolicySettings) {
    this.settings = settings
  }

  canProject(filePath: string): boolean {
    const entry = this.entries.get(filePath)
    if (!entry) return true
    return entry.totalTokens < this.settings.info_budget_ceiling
  }

  canAsk(): boolean {
    let totalAsks = 0
    for (const entry of this.entries.values()) {
      totalAsks += entry.askCount
    }
    return totalAsks < this.settings.ask_limit
  }

  currentLevel(filePath: string): ProjectionLevel {
    const entry = this.entries.get(filePath)
    if (!entry) return this.settings.default_projection_level
    return Math.min(entry.currentLevel, this.settings.max_projection_level) as ProjectionLevel
  }

  recordProjection(filePath: string, level: ProjectionLevel, tokenCount: number): void {
    const entry = this.entries.get(filePath) || {
      filePath,
      totalTokens: 0,
      askCount: 0,
      currentLevel: this.settings.default_projection_level,
    }
    entry.totalTokens += tokenCount
    entry.currentLevel = level
    this.entries.set(filePath, entry)
  }

  recordAsk(filePath: string): void {
    const entry = this.entries.get(filePath) || {
      filePath,
      totalTokens: 0,
      askCount: 0,
      currentLevel: this.settings.default_projection_level,
    }
    entry.askCount++
    this.entries.set(filePath, entry)
  }

  getEntry(filePath: string): BudgetEntry | undefined {
    return this.entries.get(filePath)
  }

  getBudgetForFile(filePath: string): { tokens: number; ceiling: number } {
    const entry = this.entries.get(filePath)
    return { tokens: entry?.totalTokens ?? 0, ceiling: this.settings.info_budget_ceiling }
  }

  getStats() {
    let totalTokens = 0
    let totalAsks = 0
    for (const entry of this.entries.values()) {
      totalTokens += entry.totalTokens
      totalAsks += entry.askCount
    }
    return { totalTokens, totalAsks, trackedFiles: this.entries.size }
  }
}
