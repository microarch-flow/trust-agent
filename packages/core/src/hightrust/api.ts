import type { HighTrustModelConfig } from "../types"

/**
 * 调用任何 OpenAI-compatible API（Ollama、vLLM、LMStudio、SGLang 等）
 */
export async function callOpenAICompatible(
  config: HighTrustModelConfig,
  prompt: string,
  maxTokens?: number,
): Promise<string> {
  const url = `${config.baseURL.replace(/\/$/, "")}/chat/completions`
  const timeout = config.timeoutMs || 60000

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`
  }

  const body = {
    model: config.model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens ?? config.maxTokens ?? 2048,
    temperature: 0.1,
    stream: false,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`API error ${response.status}: ${text.slice(0, 200)}`)
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>
    }

    return data.choices?.[0]?.message?.content || ""
  } finally {
    clearTimeout(timer)
  }
}
