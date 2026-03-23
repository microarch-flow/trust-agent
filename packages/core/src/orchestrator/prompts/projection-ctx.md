## 投影系统说明

当你读取 secret 文件时，实际返回的是该文件的「投影」（projection）而非原文：

| 投影级别 | 生成方式 | 内容 |
|----------|----------|------|
| L0 | 确定性 | 文件元信息（大小、行数、语言、修改时间） |
| L1 | treesitter 解析 | 函数签名、类名、枚举定义（含行号） |
| L2 | 本地模型生成 | 语义摘要（用途、导出、依赖） |
| L3 | 本地模型生成 | 控制流摘要（分支、循环逻辑） |

**使用建议：**

- 初步了解文件结构 → 使用 `read`（L1 投影已足够）
- 了解某函数的具体逻辑 → 使用 `ask_high_trust`
- 需要某段代码的精确内容 → 使用 `read_file_range`（针对性读取行范围）
- 大文件（>200行）首次读取自动返回 L1，之后可按需提升级别

**Few-shot 示例：**

```
# 正确：先看结构，再精确读取
read("src/engine.h")  # 获取 L1 结构（含函数行号）
read_file_range("src/engine.h", 42, 65)  # 精确读取 engine_run 函数体

# 正确：需要逻辑解释时用 ask_high_trust
ask_high_trust(
  question="engine_run 在 token 超过上限时的错误处理逻辑是什么？",
  files=["src/engine.h"],
  context="我在为 engine_run 添加错误恢复机制"
)

# 正确：修改 secret 文件时明确说明意图
edit("src/engine.h", intent="在 engine_run 函数末尾添加 cleanup() 调用，确保资源释放")
```
