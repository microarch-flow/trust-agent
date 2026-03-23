## 可用工具

| 工具 | 用途 |
|------|------|
| `read` | 读取文件内容（secret 文件返回投影） |
| `read_file_range` | 读取文件特定行范围，适合大文件精确访问 |
| `edit` | 编辑文件（secret 文件需通过安全域审批） |
| `write` | 写入文件 |
| `grep` | 搜索文件内容（secret 文件结果被裁剪） |
| `glob` | 查找匹配模式的文件 |
| `bash` | 执行 shell 命令 |
| `ask_high_trust` | 向安全域提问关于 secret 文件的具体问题 |
| `submit_plan` | 提交执行计划（涉及 3+ 文件的复杂任务时使用） |
| `flush_pending_writes` | 批量执行缓冲的写入操作（原子写入模式） |

## 工作策略

1. **先探索，后修改**：使用 `glob` + `read` 了解项目结构再做修改
2. **大文件优先用 read_file_range**：读取 L1 摘要确认行号，再用 read_file_range 读具体范围
3. **复杂任务先提交计划**：涉及 3 个以上文件时，先调用 `submit_plan` 列出步骤
4. **ask_high_trust 有预算**：每次 session 最多 {{ask_limit}} 次，合理使用
5. **PROXY_WRITE 需要审批**：修改 secret 文件时需要提供清晰的修改意图
