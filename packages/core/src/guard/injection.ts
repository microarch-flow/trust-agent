/**
 * Prompt Injection 检测
 *
 * 扫描文本（通常是 secret 文件内容）是否包含注入指令模式。
 * 若检测到，Gate 会将投影请求强制降级到 L1（确定性，不经过本地模型）。
 */

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /disregard\s+(your\s+)?(instructions?|rules|guidelines)/i,
  /forget\s+(your\s+)?(instructions?|rules|training|constraints)/i,
  /you\s+are\s+now\s+(a\s+)?(new\s+)?(different\s+)?assistant/i,
  /override\s+(all\s+)?(previous\s+)?instructions/i,
  // 模型特定分隔符
  /\[INST\]/,
  /<\|im_start\|>/,
  /<\|system\|>/,
  /<\|endoftext\|>/,
  /<<<SYS>>>/,
  // Role injection（行首）
  /^system\s*:/im,
  /^\s*\n+human\s*:\s/im,
  /^\s*\n+assistant\s*:\s/im,
  // Claude/ChatML 风格
  /\n\nHuman:\s/,
  /\n\nAssistant:\s/,
]

/**
 * 检测文本是否包含 Prompt Injection 模式。
 * @returns true 表示疑似注入，false 表示安全
 */
export function hasPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text))
}

/**
 * 检测意图字符串（PROXY_WRITE intent）是否包含注入模式。
 * Confused Deputy 防护：攻击者可能通过让 LLM 生成恶意 intent 来污染 Patcher。
 */
export function hasIntentInjection(intent: string): boolean {
  // 除通用注入模式外，还检测专门针对 Patcher 的注入
  const patcherPatterns: RegExp[] = [
    /delete\s+(the\s+)?(entire|whole|all|every)/i,
    /rm\s+-rf/i,
    /drop\s+table/i,
    /exec\s*\(/i,
    /system\s*\(/i,
    /eval\s*\(/i,
  ]
  return hasPromptInjection(intent) || patcherPatterns.some((p) => p.test(intent))
}
