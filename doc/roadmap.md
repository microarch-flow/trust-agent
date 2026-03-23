# Trust Proxy — 开发路线图

> 方法论：Run-first（先跑起来，再沿着真实失败点驱动后续冲刺）
> 节奏：短冲刺，每阶段 1-3 周，结束时有可验证里程碑
> 总周期：约 15 周（~4 个月）到 v0.1.0

---

## 总览

| Sprint | 时长 | 主题 | 核心产出 |
|--------|------|------|---------|
| Sprint 0 | 1 周 | 首次运行 | 缺陷清单 + 第一份真实审计日志 |
| Sprint 1 | 2 周 | 链路稳定 | 能持续工作，不随机崩溃 |
| Sprint 2 | 2 周 | 投影质量 | llama.cpp L2/L3 实测可用 |
| Sprint 3 | 2 周 | 安全加固 | 通过 red team 测试场景 |
| Sprint 4 | 2 周 | 可观测性 | 用户实时看到信任域切换 |
| Sprint 5 | 3 周 | Agent 能力 | 能处理多文件复杂任务 |
| Sprint 6 | 3 周 | 产品化 | 可发布给别人用的 v0.1.0 |

---

## Sprint 0 — 首次运行（1 周）

**目标**：在真实项目上完整跑通 `trust-agent run`，记录所有崩溃点。

```
[ ] 配置 .trust-policy.yml：填写 llama.cpp API 端点 + 云端 API key
[ ] trust-agent validate --check-connectivity 修复配置错误
[ ] 运行只读任务（触发 PASS 路径）
[ ] 运行 secret 文件读取（触发 PROXY_READ + L1 投影）
[ ] 运行 secret 文件修改（触发 PROXY_WRITE + Patcher）
[ ] 记录所有报错到 sprint0-findings.md
[ ] 运行 bun test，记录失败用例
```

**验收**：至少一条完整链路跑通 + 审计日志有内容

---

## Sprint 1 — 链路稳定（2 周）

**目标**：修掉 Sprint 0 暴露的 P0 问题，agent 能持续工作不崩溃。

**Week 1 — 核心修复**
```
[ ] 流式输出（stream: true，实时打印 token）
[ ] 真实 token 计数（接入 tiktoken 或使用 API usage 字段）
[ ] 工具失败不崩溃（捕获异常 → 返回 [ERROR] → LLM 自行决策）
```

**Week 2 — Orchestrator 基础能力**
```
[ ] Human-in-the-loop：PROXY_WRITE 触发时展示 diff 预览，等待 y/n 审批
[ ] Session 恢复：messages 持久化到 .trust-proxy/sessions/<id>.json
                  trust-agent run --resume <id> 从中断处继续
[ ] 上下文溢出保护：超过 80% 阈值时截断早期对话保留 system prompt
```

**验收**：
- `trust-agent run "添加 reset() 方法"` 完整走完 PROXY_WRITE 审批流程
- Ctrl+C 后 `--resume` 能恢复
- bun test 全部通过

---

## Sprint 2 — 投影质量（2 周）

**目标**：llama.cpp 驱动的 L2/L3 投影和 Meta-Guard 在真实代码上实际可用。

**Week 1 — 投影链路实测**
```
[ ] 写 script/test-projection.ts：输入文件 → 输出四级投影 + 耗时 + token 数
[ ] Projector Prompt 调优：对比 3 种变体，选小模型效果最好的
[ ] Prompt 外置到配置（security.projection.prompts.l2 / l3）
[ ] 多语言 L1 投影：Python（def/class）、Go（func/type）、C/C++（extern/class）
```

**Week 2 — Guard 实测**
```
[ ] Guard Layer 2 误报率测试，根据实测调整 similarity_threshold 默认值
[ ] Meta-Guard 小模型 prompt 调优 + few-shot examples（2 SAFE + 2 UNSAFE）
[ ] trust-agent validate --test-projection <file>：打印四级投影供人工审查
```

**验收**：
- `validate --test-projection` 输出合理
- C++ 文件 L1 能提取函数签名
- Guard Layer 2 误报率 < 10%

---

## Sprint 3 — 安全加固（2 周）

**目标**：对已运行的系统做系统性安全验证，关闭已知攻击面。

**Week 1 — 主动攻击测试**
```
[ ] Canary 自动植入：canary.auto_plant: true，session 开始注入，结束后验证
[ ] Prompt Injection 检测：secret 文件投影前扫描注入关键词，检测到则降级 L0/L1
[ ] Confused Deputy 防护：Patcher intent 注入检测 + system prompt 约束
```

**Week 2 — 编码绕过 + 审计完整性**
```
[ ] 编码绕过：Guard Layer 1 增加 base64/hex 解码后再匹配
[ ] 审计日志 HMAC 签名：每条日志附签名，trust-agent status --verify 检查完整性
[ ] packages/eval/src/redteam.test.ts：4 种攻击场景测试用例
```

**验收**：
- redteam.test.ts 全部通过
- `trust-agent run` 后 `canary_test.passed: true`
- `status --verify` 报告签名链完整

---

## Sprint 4 — 可观测性（2 周）

**目标**：用户实时知道 agent 在做什么，信任域切换可见。

**Week 1 — 实时进度输出**
```
[ ] TrustDomain EventEmitter：Gate/Projection/Patcher 裁决后 emit 事件
[ ] CLI Reporter 类：统一输出格式，实时展示每次工具调用的信任域

    示例输出格式：
    ✓ [PASS]       read_file src/utils/helpers.ts (12ms)
    ⟳ [PROXY_READ] src/core/engine.ts → 投影 L2 中...
    ✓ [PROJ L2]    src/core/engine.ts 342tok (llama.cpp 1.2s)
    ✓ [GUARD]      三层检测通过
    ⚠ [PROXY_WRITE] diff 预览 + 审批界面

[ ] EventEmitter 事件同步写入 audit logger（展示与记录保持一致）
```

**Week 2 — 错误诊断 + 信息预算展示**
```
[ ] 错误附上下文：发生在哪个工具调用 + DENY 原因 + 改进建议
[ ] 信息预算实时展示：[budget: engine.ts 1240/4096tok | ask: 3/20次]
[ ] trust-agent status 改为结构化摘要（工具调用统计 + 投影统计 + Canary 结果）
```

**验收**：
- 运行时无需查看日志文件，终端即可判断当前信任域
- PROXY_WRITE 审批界面清晰展示跨文件 diff

---

## Sprint 5 — Agent 能力升级（3 周）

**目标**：agent 能处理真实编码任务中的复杂场景。

**Week 1 — 上下文工程**
```
[ ] 最小披露原则：大文件（>200 行）默认只返回结构摘要 + 行号
                  新增工具 read_file_range(file, startLine, endLine)
[ ] 智能上下文压缩：超阈值时调用云端 LLM 生成摘要替换中间轮次
[ ] Planning 分离：复杂任务（>3 文件）先输出执行计划，偏离时暂停提示
```

**Week 2 — 多文件能力**
```
[ ] 多文件原子操作：收集所有 PROXY_WRITE → 一次展示跨文件 diff → 全部写入或回滚
[ ] 新文件信任分类：按父目录规则自动归类新创建文件的信任级别
[ ] Git 集成（基础版）：写入前 git stash，完成后提示 git commit
```

**Week 3 — Prompt 工程**
```
[ ] System Prompt 外置到 packages/core/src/orchestrator/prompts/
    * system.md / tool-guide.md / projection-ctx.md
[ ] Few-shot 示例库：PROXY_READ 用法、ask_high_trust 时机、PROXY_WRITE 意图表达
[ ] packages/eval/src/behavior.test.ts：Planning 分离、原子操作、上下文压缩回归测试
```

**验收**：
- `run "将 SchedulerEngine 的队列逻辑抽取为独立模块"` 生成跨文件原子 diff
- behavior.test.ts 全部通过
- 10 轮以上对话不触发截断

---

## Sprint 6 — 产品化（3 周）

**目标**：发布 v0.1.0，具备开源项目和商业产品基础条件。

**Week 1 — 稳定性与兼容性**
```
[ ] packages/eval/src/regression.test.ts：覆盖只读 / 单文件修改 / 多文件重构三种任务类型
[ ] 4 种语言兼容性验证：TypeScript / Python / Go / C++
[ ] CLI 输出统一为英文（--lang zh/en 参数保留中文选项）
```

**Week 2 — 文档与开发者体验**
```
[ ] Getting Started：从零到第一次 run 成功，15 分钟内完成
    （纯云端 / 混合模式 / 完整模式 三种配置示例）
[ ] 配置参考文档：.trust-policy.yml 每个字段说明 + 默认值 + 影响范围
[ ] CONTRIBUTING.md：跑测试 / 添加语言 / 添加 Guard 规则 / 添加工具
[ ] packages/examples/：ts-only / python / mixed 三个最小示例项目
```

**Week 3 — 发布**
```
[ ] MCP Server 模式：trust-agent serve，暴露 MCP 协议接口
                     让 Claude Desktop / opencode 通过 MCP 调用 trust-agent
[ ] GitHub Actions：push tag → 自动构建 4 平台二进制 → 上传 Release Assets
[ ] curl | sh 一行安装脚本
[ ] 开源发布检查：LICENSE / .gitignore / hardcode key 清除 / README 首屏
```

**验收**：
- 陌生用户按 README 操作，15 分钟内跑出第一个结果
- bun test 全套（含 regression）通过
- GitHub Release 有 4 个平台二进制
- `trust-agent serve` 被 Claude Desktop 识别为 MCP server

---

## 里程碑总结

```
Week 1   Sprint 0 完成 → 第一份真实审计日志
Week 3   Sprint 1 完成 → 能持续工作的 agent
Week 5   Sprint 2 完成 → llama.cpp 投影链路可用
Week 7   Sprint 3 完成 → 通过 red team 验证
Week 9   Sprint 4 完成 → 可观测的 agent
Week 12  Sprint 5 完成 → 能处理复杂任务
Week 15  Sprint 6 完成 → v0.1.0 发布
```
