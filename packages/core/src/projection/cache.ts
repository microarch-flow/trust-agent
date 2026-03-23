import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs"
import { join, dirname } from "path"
import { createHash } from "crypto"
import type { ProjectionLevel, ProjectionResult } from "../types"

export type CacheEntry = ProjectionResult & {
  filePath: string
  level: ProjectionLevel
}

export type CacheStats = {
  hits: number
  misses: number
  entries: number
}

export class ProjectionCache {
  private memory = new Map<string, CacheEntry>()
  private stats: CacheStats = { hits: 0, misses: 0, entries: 0 }
  private cacheDir: string

  constructor(projectRoot: string) {
    this.cacheDir = join(projectRoot, ".trust-proxy", "cache", "projections")
  }

  private key(filePath: string, level: ProjectionLevel): string {
    return `${filePath}::${level}`
  }

  private diskPath(filePath: string, level: ProjectionLevel): string {
    const hash = createHash("sha256").update(filePath).digest("hex").slice(0, 16)
    return join(this.cacheDir, `${hash}_L${level}.json`)
  }

  get(filePath: string, level: ProjectionLevel, currentHash: string): CacheEntry | null {
    const k = this.key(filePath, level)

    // 先查内存
    const mem = this.memory.get(k)
    if (mem && mem.sourceHash === currentHash) {
      this.stats.hits++
      return mem
    }

    // 再查磁盘
    const dp = this.diskPath(filePath, level)
    if (existsSync(dp)) {
      try {
        const entry = JSON.parse(readFileSync(dp, "utf-8")) as CacheEntry
        if (entry.sourceHash === currentHash) {
          this.memory.set(k, entry)
          this.stats.hits++
          return entry
        }
        // hash 不匹配，删除过期缓存
        unlinkSync(dp)
      } catch {
        // 损坏的缓存文件，忽略
      }
    }

    this.stats.misses++
    return null
  }

  set(filePath: string, level: ProjectionLevel, result: ProjectionResult): void {
    const entry: CacheEntry = { ...result, filePath, level }
    const k = this.key(filePath, level)
    this.memory.set(k, entry)
    this.stats.entries = this.memory.size

    // 写磁盘
    const dp = this.diskPath(filePath, level)
    mkdirSync(dirname(dp), { recursive: true })
    writeFileSync(dp, JSON.stringify(entry, null, 2))
  }

  invalidate(filePath: string): void {
    for (const [k, entry] of this.memory) {
      if (entry.filePath === filePath) {
        this.memory.delete(k)
        const dp = this.diskPath(filePath, entry.level)
        if (existsSync(dp)) unlinkSync(dp)
      }
    }
    this.stats.entries = this.memory.size
  }

  invalidateAll(): void {
    this.memory.clear()
    this.stats.entries = 0
    // 不删磁盘缓存目录，只在 get 时校验 hash
  }

  getStats(): CacheStats {
    return { ...this.stats }
  }
}
