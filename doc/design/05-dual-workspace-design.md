# 05 — 双 Workspace 隔离设计

## 1. 目标

彻底封堵 bash/grep/cat 等工具对 secret 文件的访问。不通过命令解析或逻辑拦截，而是让 low-trust LLM 的工作目录中**物理上不存在 secret 文件原文**。

## 2. 两个 Workspace

```
{project_root}/                        ← real workspace（真实仓库）
  .git/
  .trust-policy.yml
  src/
    core/crypto/aes.cpp                ← secret 原文
    core/engine/scheduler.cpp          ← secret 原文
    api/handler.cpp                    ← public 原文
  include/
    llama.h                            ← public 原文
  tests/
    test-aes.cpp                       ← public 原文

{project_root}/.trust-proxy/workspace/ ← public workspace（LLM 工作区）
  src/
    core/crypto/aes.cpp                ← projection 文本（非原文！）
    core/engine/scheduler.cpp          ← projection 文本
    api/handler.cpp                    ← 原文（symlink 或 copy）
  include/
    llama.h                            ← 原文
  tests/
    test-aes.cpp                       ← 原文
```

## 3. 文件映射规则

```typescript
type FileMapping =
  | { type: "passthrough"; realPath: string; publicPath: string }   // public: 直接链接
  | { type: "projected"; realPath: string; publicPath: string;      // secret: 投影文件
      projectionLevel: ProjectionLevel }
  | { type: "excluded"; realPath: string }                          // 完全排除（不出现在 public ws）

function mapFile(filePath: string, assetMap: AssetMap): FileMapping {
  const level = assetMap.getLevel(filePath)

  switch (level) {
    case "public":
      return { type: "passthrough", realPath: filePath, publicPath: filePath }
    case "secret":
    case "derived":
      return {
        type: "projected",
        realPath: filePath,
        publicPath: filePath,
        projectionLevel: assetMap.getSettings().default_projection_level
      }
  }
}
```

## 4. 初始化流程

```typescript
async function initWorkspace(projectRoot: string, assetMap: AssetMap): Promise<void> {
  const publicRoot = join(projectRoot, ".trust-proxy", "workspace")

  // 1. 创建目录结构（镜像 real workspace 的目录树）
  const allFiles = await glob("**/*", { cwd: projectRoot, nodir: true })
  for (const file of allFiles) {
    const mapping = mapFile(file, assetMap)
    const targetDir = dirname(join(publicRoot, file))
    await mkdir(targetDir, { recursive: true })

    switch (mapping.type) {
      case "passthrough":
        // 创建 symlink 指向 real workspace（节省空间，自动同步）
        await symlink(join(projectRoot, file), join(publicRoot, file))
        break

      case "projected":
        // 生成 projection 文件
        const projection = await projectionEngine.project({
          filePath: join(projectRoot, file),
          level: mapping.projectionLevel,
          language: detectLanguage(file),
        })
        await writeFile(join(publicRoot, file), formatProjectionAsFile(projection))
        break

      case "excluded":
        // 不创建任何文件
        break
    }
  }

  // 2. 复制不可 symlink 的特殊文件
  //    .gitignore, Makefile, CMakeLists.txt 等 → 直接复制
  //    这些文件通常不含 secret，但修改它们可能影响构建

  // 3. 写入 workspace 元数据
  await writeFile(join(publicRoot, ".trust-proxy-workspace"), JSON.stringify({
    realRoot: projectRoot,
    createdAt: new Date().toISOString(),
    fileCount: allFiles.length,
    secretCount: allFiles.filter(f => assetMap.getLevel(f) !== "public").length,
  }))
}
```

## 5. 同步机制

### 5.1 Public 文件：双向同步

```
方案：使用 symlink
  public workspace 中的 public 文件是指向 real workspace 的符号链接
  LLM 通过 symlink 读写 → 实际操作 real workspace 中的文件
  零同步开销

注意：
  - 新创建的文件默认在 public workspace 中，需要同步到 real workspace
  - 新文件的 asset level 默认为 public（除非路径匹配 secret pattern）
```

### 5.2 Secret 文件修改后：projection 更新

```
Patcher 在 real workspace 中修改了 secret 文件后：
  1. 使 projection cache 中该文件的条目失效
  2. 重新生成 projection
  3. 更新 public workspace 中对应的 projection 文件
  4. 通知 Orchestrator projection 已更新
     （如果 LLM 当前上下文中有旧版 projection，无法撤回，
      但后续 read 会拿到新版）
```

### 5.3 git 操作

```
git 操作发生在 real workspace，不在 public workspace

LLM 如果调 bash("git status"):
  → 在 public workspace 中执行
  → 但 public workspace 不是 git repo
  → 需要特殊处理

方案 A：public workspace 也初始化为 git worktree
  优点：git 命令正常工作
  缺点：需要管理 worktree 同步

方案 B：拦截 git 命令，在 real workspace 中执行
  优点：结果准确
  缺点：需要 bash 命令解析

方案 C [推荐]：提供 git 相关的 tool（不走 bash）
  git_status, git_diff, git_log 等
  这些 tool 在 real workspace 中执行
  结果中 secret 文件的 diff 内容被 redact
```

## 6. Projection 文件的格式

secret 文件在 public workspace 中存储为什么格式？

```
方案 A：保留原始文件扩展名，内容是 projection 文本
  src/core/crypto/aes.cpp 的内容变成：

  // [TRUST-PROXY PROJECTION - Level 2]
  // This file is a security projection. Original source is in the secure workspace.
  // Do not attempt to compile this file directly.
  //
  // Module: aes_encryption
  // Exports:
  //   void aes_encrypt(const uint8_t* key, ...)
  //   void aes_decrypt(...)
  // ...

  优点：LLM 用 read/cat 都能看到，文件名不变
  缺点：如果 LLM 试图编译这个文件会失败

方案 B [推荐]：保留扩展名，内容是可编译的 stub
  src/core/crypto/aes.cpp 的内容变成：

  // [TRUST-PROXY PROJECTION - Level 1]
  // Auto-generated stub. Actual implementation in secure workspace.

  #include "crypto_common.h"

  void aes_encrypt(const uint8_t* key, const uint8_t* input,
                   uint8_t* output, size_t len) {
    // [SECRET IMPLEMENTATION]
    // Behavior: 使用给定密钥对输入数据进行 AES 加密
    // Precondition: len 是 16 的倍数
    // Postcondition: output 包含加密后数据
    throw std::runtime_error("trust-proxy: stub - use secure workspace to build");
  }

  // ... 其他函数类似

  优点：语法正确，IDE 不会报错，LLM 可以理解接口
  缺点：生成 stub 比纯文本 projection 更复杂
```

## 7. 构建与测试

在 public workspace 中构建会失败（stub 不可执行）。构建和测试必须在 real workspace 中进行。

```
LLM 调 bash("cmake --build build"):
  方案 1：在 real workspace 中执行（如果 LLM 没有修改 secret 文件，直接跑）
  方案 2：先把 LLM 对 public 文件的修改同步到 real workspace，再在 real 中构建

  推荐方案 1 + symlink：
    public 文件通过 symlink 已经同步
    secret 文件的修改通过 Patcher 已经同步
    所以 real workspace 始终是最新的
    构建命令重定向到 real workspace 即可
```

```typescript
// bash tool 包装
function wrapBashForWorkspace(originalBash: Tool): Tool {
  return {
    ...originalBash,
    execute: async (args) => {
      const command = args.command as string

      // 构建/测试命令在 real workspace 中执行
      if (isBuildCommand(command)) {
        return originalBash.execute({ ...args, cwd: realWorkspaceRoot })
      }

      // 其他命令在 public workspace 中执行
      return originalBash.execute({ ...args, cwd: publicWorkspaceRoot })
    }
  }
}

function isBuildCommand(cmd: string): boolean {
  const buildPatterns = [
    /^(cmake|make|cargo|go build|npm run build|tsc|gcc|g\+\+|clang)/,
    /^(ctest|pytest|jest|vitest|go test|cargo test)/,
    /^(npm test|bun test|yarn test)/,
  ]
  return buildPatterns.some(p => p.test(cmd.trim()))
}
```

## 8. 生命周期

```
trust-agent init
  → 创建 .trust-proxy/workspace/
  → 初始化 symlinks + projection 文件

trust-agent run "任务"
  → Orchestrator 把 LLM 的 cwd 设为 public workspace
  → LLM 工作...
  → session 结束

trust-agent clean
  → 删除 .trust-proxy/workspace/

文件变更（real workspace 中 secret 文件被手动编辑）：
  → watcher 检测到变化
  → 重新生成 projection
  → 更新 public workspace 中的 projection 文件

.trust-policy.yml 变更：
  → 重新计算所有文件的 asset level
  → 可能需要：
    - 把 symlink 变成 projection（文件从 public 变成 secret）
    - 把 projection 变成 symlink（文件从 secret 变成 public）
```

## 9. Phase 实施

| Phase | 实施内容 |
|-------|---------|
| P1 | 不实现双 workspace。LLM 直接在 real workspace 工作，Trust Gate 通过 tool 包装拦截 |
| P3 | 实现双 workspace。创建 public workspace + symlink + projection 文件 |
| P4 | 添加文件 watcher、构建命令重定向、git 集成 |

Phase 1 的简化理由：双 workspace 增加了大量复杂度（同步、symlink、构建重定向）。在核心的 Trust Gate + Projection 系统验证通过之前，不值得投入。Phase 1 中 bash 漏洞通过以下方式缓解：
- LLM 的 system prompt 中不告诉它 secret 文件的路径
- Trust Gate 拦截 read/edit tool call
- bash 中的 cat/grep 如果碰巧读到 secret 文件，这个内容会被发给 cloud LLM — 这是 Phase 1 的已知风险
