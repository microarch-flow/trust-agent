import {
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  lstatSync,
} from "fs"
import { join, relative, dirname, basename } from "path"
import type { AssetMap } from "../asset/policy"
import type { ProjectionEngine } from "../projection/engine"
import type { ProjectionLevel } from "../types"

export type WorkspaceInfo = {
  realRoot: string
  publicRoot: string
  createdAt: string
  fileCount: number
  secretCount: number
  publicCount: number
  symlinkCount: number
  projectionCount: number
}

const META_FILE = ".trust-proxy-workspace"
const IGNORE_DIRS = new Set([".git", "node_modules", ".trust-proxy", "dist", ".next", "__pycache__", ".venv"])
const IGNORE_FILES = new Set([".DS_Store", "Thumbs.db"])

/**
 * 双 Workspace 管理器
 *
 * 创建一个 public workspace，其中：
 * - public 文件 → symlink 到 real workspace（零拷贝，自动同步）
 * - secret 文件 → projection 文本文件（保留原始扩展名）
 * - .trust-proxy 和 node_modules 等不映射
 */
export class WorkspaceManager {
  private realRoot: string
  private publicRoot: string
  private assetMap: AssetMap
  private projectionEngine: ProjectionEngine

  constructor(
    projectRoot: string,
    assetMap: AssetMap,
    projectionEngine: ProjectionEngine,
  ) {
    this.realRoot = projectRoot
    this.publicRoot = join(projectRoot, ".trust-proxy", "workspace")
    this.assetMap = assetMap
    this.projectionEngine = projectionEngine
  }

  /**
   * 初始化 public workspace
   */
  async init(): Promise<WorkspaceInfo> {
    // 清理旧 workspace
    if (existsSync(this.publicRoot)) {
      rmSync(this.publicRoot, { recursive: true })
    }
    mkdirSync(this.publicRoot, { recursive: true })

    const allFiles = this.listAllFiles(this.realRoot)
    let symlinkCount = 0
    let projectionCount = 0
    let secretCount = 0
    let publicCount = 0

    const defaultLevel = this.assetMap.getSettings().default_projection_level

    for (const relPath of allFiles) {
      const realPath = join(this.realRoot, relPath)
      const publicPath = join(this.publicRoot, relPath)
      const level = this.assetMap.getLevel(realPath)

      // 确保目标目录存在
      mkdirSync(dirname(publicPath), { recursive: true })

      if (level === "public") {
        // symlink 到 real workspace
        try {
          symlinkSync(realPath, publicPath)
          symlinkCount++
          publicCount++
        } catch {
          // symlink 失败时直接复制（Windows 兼容）
          writeFileSync(publicPath, readFileSync(realPath))
          publicCount++
        }
      } else {
        // secret/derived → 生成 projection 文件
        secretCount++
        try {
          const result = await this.projectionEngine.project({
            filePath: realPath,
            level: defaultLevel,
          })
          const content = formatProjectionAsFile(relPath, result.content, result.level)
          writeFileSync(publicPath, content)
          projectionCount++
        } catch {
          // 投影失败，写入占位文件
          writeFileSync(publicPath, formatPlaceholder(relPath))
          projectionCount++
        }
      }
    }

    // 写入 workspace 元数据
    const info: WorkspaceInfo = {
      realRoot: this.realRoot,
      publicRoot: this.publicRoot,
      createdAt: new Date().toISOString(),
      fileCount: allFiles.length,
      secretCount,
      publicCount,
      symlinkCount,
      projectionCount,
    }

    writeFileSync(join(this.publicRoot, META_FILE), JSON.stringify(info, null, 2))

    return info
  }

  /**
   * 更新单个 secret 文件的 projection（Patcher 修改后调用）
   */
  async updateProjection(filePath: string): Promise<void> {
    const relPath = relative(this.realRoot, filePath)
    const publicPath = join(this.publicRoot, relPath)
    const defaultLevel = this.assetMap.getSettings().default_projection_level

    // 先失效 cache
    this.projectionEngine.invalidate(filePath)

    try {
      const result = await this.projectionEngine.project({
        filePath,
        level: defaultLevel,
      })
      mkdirSync(dirname(publicPath), { recursive: true })
      writeFileSync(publicPath, formatProjectionAsFile(relPath, result.content, result.level))
    } catch {
      writeFileSync(publicPath, formatPlaceholder(relPath))
    }
  }

  /**
   * 清理 public workspace
   */
  clean(): void {
    if (existsSync(this.publicRoot)) {
      rmSync(this.publicRoot, { recursive: true })
    }
  }

  /**
   * 检查 workspace 是否已初始化
   */
  isInitialized(): boolean {
    return existsSync(join(this.publicRoot, META_FILE))
  }

  /**
   * 读取 workspace 信息
   */
  getInfo(): WorkspaceInfo | null {
    const metaPath = join(this.publicRoot, META_FILE)
    if (!existsSync(metaPath)) return null
    try {
      return JSON.parse(readFileSync(metaPath, "utf-8"))
    } catch {
      return null
    }
  }

  getPublicRoot(): string {
    return this.publicRoot
  }

  getRealRoot(): string {
    return this.realRoot
  }

  /**
   * 递归列出所有文件（相对路径）
   */
  private listAllFiles(dir: string, base?: string): string[] {
    const results: string[] = []
    const baseDir = base || dir

    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry) || IGNORE_FILES.has(entry)) continue

        const fullPath = join(dir, entry)
        try {
          const stat = lstatSync(fullPath)
          if (stat.isSymbolicLink()) continue // 跳过已有的 symlinks
          if (stat.isFile()) {
            results.push(relative(baseDir, fullPath))
          } else if (stat.isDirectory()) {
            results.push(...this.listAllFiles(fullPath, baseDir))
          }
        } catch {
          // skip inaccessible
        }
      }
    } catch {
      // skip unreadable dirs
    }

    return results
  }
}

// ===== 辅助函数 =====

function formatProjectionAsFile(
  relPath: string,
  projectionContent: string,
  level: ProjectionLevel,
): string {
  const ext = relPath.split(".").pop() || ""
  const comment = getCommentStyle(ext)

  return `${comment.start} [TRUST-PROXY PROJECTION - Level ${level}]${comment.end}
${comment.start} This file is a security projection. Original source is in the secure workspace.${comment.end}
${comment.start} Do not attempt to compile or execute this file directly.${comment.end}

${projectionContent}
`
}

function formatPlaceholder(relPath: string): string {
  const ext = relPath.split(".").pop() || ""
  const comment = getCommentStyle(ext)

  return `${comment.start} [TRUST-PROXY] This is a secret file.${comment.end}
${comment.start} Use ask_high_trust to learn about this file.${comment.end}
`
}

function getCommentStyle(ext: string): { start: string; end: string } {
  switch (ext) {
    case "py":
      return { start: "#", end: "" }
    case "html":
    case "xml":
    case "svg":
      return { start: "<!--", end: " -->" }
    case "css":
      return { start: "/*", end: " */" }
    default:
      return { start: "//", end: "" }
  }
}
