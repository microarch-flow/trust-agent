import { readFileSync, writeFileSync, mkdirSync } from "fs"
import { execSync } from "child_process"
import { dirname, join } from "path"
import { readdirSync, statSync } from "fs"
import type { ToolDefinition, ToolResult } from "../types"

export type ToolsConfig = {
  projectRoot: string
  /** 双 workspace 模式下的 public workspace 根目录 */
  publicRoot?: string
  /** grep 排除目录（默认 node_modules/.git/dist/.trust-proxy） */
  grepExcludeDirs?: string[]
  /** bash 策略（默认 workspace_isolated） */
  bashPolicy?: "workspace_isolated" | "unrestricted" | "disabled"
}

const DEFAULT_GREP_EXCLUDE = ["node_modules", ".git", "dist", ".trust-proxy"]

/**
 * 创建内建工具集
 * 这些是 LLM 可以调用的基础工具，会被 Trust Gate 包装
 */
export function createBuiltinTools(
  projectRoot: string,
  publicRoot?: string,
  opts: { grepExcludeDirs?: string[]; bashPolicy?: string } = {},
): ToolDefinition[] {
  const grepExcludeDirs = opts.grepExcludeDirs ?? DEFAULT_GREP_EXCLUDE
  const bashPolicy = (opts.bashPolicy ?? "workspace_isolated") as ToolsConfig["bashPolicy"]
  return [
    createReadTool(projectRoot),
    createReadFileRangeTool(),
    createEditTool(projectRoot),
    createWriteTool(projectRoot),
    createGrepTool(publicRoot || projectRoot, grepExcludeDirs),
    createGlobTool(publicRoot || projectRoot),
    createBashTool(projectRoot, publicRoot, bashPolicy),
  ]
}

function createReadTool(_projectRoot: string): ToolDefinition {
  return {
    name: "read",
    description: "读取文件内容。对于 secret 文件，返回投影而非原文。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要读取的文件路径" },
      },
      required: ["path"],
    },
    execute: async (args): Promise<ToolResult> => {
      const filePath = args.path as string
      try {
        const content = readFileSync(filePath, "utf-8")
        return { output: content }
      } catch (err) {
        return { output: `[ERROR] 无法读取文件: ${err}` }
      }
    },
  }
}

function createReadFileRangeTool(): ToolDefinition {
  return {
    name: "read_file_range",
    description: "读取文件特定行范围的内容。适用于大文件的精确读取。对 secret 文件返回该行范围的投影。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        start_line: { type: "number", description: "起始行号（1-indexed，含）" },
        end_line: { type: "number", description: "结束行号（1-indexed，含）" },
      },
      required: ["path", "start_line", "end_line"],
    },
    execute: async (args): Promise<ToolResult> => {
      const filePath = args.path as string
      const startLine = Math.max(1, args.start_line as number)
      const endLine = args.end_line as number
      try {
        const content = readFileSync(filePath, "utf-8")
        const lines = content.split("\n")
        const total = lines.length
        const end = Math.min(endLine, total)
        const selected = lines.slice(startLine - 1, end)
        const output = selected.map((l, i) => `${startLine + i}: ${l}`).join("\n")
        return { output: output || "(no content in range)" }
      } catch (err) {
        return { output: `[ERROR] 无法读取文件: ${err}` }
      }
    },
  }
}

function createEditTool(_projectRoot: string): ToolDefinition {
  return {
    name: "edit",
    description: "编辑文件。提供旧文本和新文本进行替换。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要编辑的文件路径" },
        old_string: { type: "string", description: "要替换的原始文本" },
        new_string: { type: "string", description: "替换后的新文本" },
      },
      required: ["path", "old_string", "new_string"],
    },
    execute: async (args): Promise<ToolResult> => {
      const filePath = args.path as string
      const oldStr = args.old_string as string
      const newStr = args.new_string as string
      try {
        const content = readFileSync(filePath, "utf-8")
        if (!content.includes(oldStr)) {
          return { output: `[ERROR] 未找到要替换的文本` }
        }
        const updated = content.replace(oldStr, newStr)
        writeFileSync(filePath, updated)
        return { output: `已编辑 ${filePath}` }
      } catch (err) {
        return { output: `[ERROR] 编辑失败: ${err}` }
      }
    },
  }
}

function createWriteTool(_projectRoot: string): ToolDefinition {
  return {
    name: "write",
    description: "写入文件内容。如果文件存在则覆盖。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要写入的文件路径" },
        content: { type: "string", description: "文件内容" },
      },
      required: ["path", "content"],
    },
    execute: async (args): Promise<ToolResult> => {
      const filePath = args.path as string
      const content = args.content as string
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(filePath, content)
        return { output: `已写入 ${filePath} (${content.length} chars)` }
      } catch (err) {
        return { output: `[ERROR] 写入失败: ${err}` }
      }
    },
  }
}

function createGrepTool(projectRoot: string, excludeDirs: string[] = DEFAULT_GREP_EXCLUDE): ToolDefinition {
  return {
    name: "grep",
    description: "在项目文件中搜索文本。secret 文件的匹配结果会被裁剪。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "搜索模式（正则表达式）" },
        path: { type: "string", description: "搜索路径（默认为项目根目录）" },
        glob: { type: "string", description: "文件 glob 模式过滤" },
      },
      required: ["pattern"],
    },
    execute: async (args): Promise<ToolResult> => {
      const pattern = args.pattern as string
      const searchPath = (args.path as string) || projectRoot
      const globPattern = args.glob as string | undefined
      try {
        const excludeFlags = excludeDirs.map(d => `--exclude-dir=${d}`).join(" ")
        const escapedPattern = pattern.replace(/"/g, '\\"')
        let cmd = `grep -rn ${excludeFlags} "${escapedPattern}" "${searchPath}" --include='*' 2>/dev/null || true`
        if (globPattern) {
          cmd = `grep -rn ${excludeFlags} "${escapedPattern}" "${searchPath}" --include='${globPattern}' 2>/dev/null || true`
        }
        const output = execSync(cmd, {
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
          timeout: 30000,
        })
        return { output: output || "(no matches)" }
      } catch {
        return { output: "(grep error or no matches)" }
      }
    },
  }
}

function createGlobTool(projectRoot: string): ToolDefinition {
  return {
    name: "glob",
    description: "查找匹配模式的文件路径。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob 模式（如 **/*.ts）" },
        path: { type: "string", description: "搜索起始路径" },
      },
      required: ["pattern"],
    },
    execute: async (args): Promise<ToolResult> => {
      const pattern = args.pattern as string
      const basePath = (args.path as string) || projectRoot
      try {
        // 简化实现：递归列出文件然后匹配
        const files = listFilesRecursive(basePath, 5)
        const { default: picomatch } = await import("picomatch")
        const isMatch = picomatch(pattern)
        const matched = files.filter((f) => isMatch(f))
        return { output: matched.join("\n") || "(no matches)" }
      } catch (err) {
        return { output: `[ERROR] glob 失败: ${err}` }
      }
    },
  }
}

function createBashTool(
  projectRoot: string,
  publicRoot?: string,
  bashPolicy: ToolsConfig["bashPolicy"] = "workspace_isolated",
): ToolDefinition {
  return {
    name: "bash",
    description: "执行 shell 命令。命令在项目工作目录下执行。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 shell 命令" },
        timeout: { type: "number", description: "超时时间（毫秒），默认 30000" },
      },
      required: ["command"],
    },
    execute: async (args): Promise<ToolResult> => {
      const command = args.command as string
      const timeout = (args.timeout as number) || 30000

      // bash 策略路由
      let cwd = projectRoot
      if (bashPolicy === "disabled") {
        return { output: "[DENIED] bash 工具已在策略中禁用" }
      } else if (bashPolicy === "unrestricted") {
        cwd = projectRoot
      } else {
        // workspace_isolated: 普通命令走 public workspace，构建/测试走真实目录
        cwd = publicRoot || projectRoot
        if (publicRoot && isBuildOrTestCommand(command)) {
          cwd = projectRoot
        }
      }

      try {
        const output = execSync(command, {
          cwd,
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
          timeout,
        })
        return { output: output || "(no output)" }
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; stderr?: string; message?: string }
        return {
          output: `[EXIT] ${execErr.stderr || execErr.stdout || execErr.message || "command failed"}`,
        }
      }
    },
  }
}

/**
 * 检测命令是否是构建/测试命令（应在 real workspace 中执行）
 */
function isBuildOrTestCommand(cmd: string): boolean {
  const trimmed = cmd.trim()
  const patterns = [
    /^(cmake|make|cargo|go\s+build|npm\s+run\s+build|tsc|gcc|g\+\+|clang)/,
    /^(ctest|pytest|jest|vitest|go\s+test|cargo\s+test)/,
    /^(npm\s+test|bun\s+test|yarn\s+test|pnpm\s+test)/,
    /^(npm\s+run|bun\s+run|yarn\s+run|pnpm\s+run)/,
    /^git\s+/,
  ]
  return patterns.some(p => p.test(trimmed))
}

// ===== 辅助函数 =====

function listFilesRecursive(dir: string, maxDepth: number, currentDepth = 0): string[] {
  if (currentDepth >= maxDepth) return []
  const results: string[] = []

  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue
      const fullPath = join(dir, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isFile()) {
          results.push(fullPath)
        } else if (stat.isDirectory()) {
          results.push(...listFilesRecursive(fullPath, maxDepth, currentDepth + 1))
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
