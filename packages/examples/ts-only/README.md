# trust-agent example: TypeScript-only

Minimal TypeScript project demonstrating Trust Agent with a cloud-only (Anthropic) driver.

## Setup

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Run

```bash
cd packages/examples/ts-only
trust-agent run "Review the scorer and suggest performance improvements"
```

You should see the `src/core/scorer.ts` file returned as a projection (L1 signatures only),
while `src/utils/format.ts` is returned as raw content.

## Structure

```
src/
  core/scorer.ts     ← SECRET (projection only)
  utils/format.ts    ← PUBLIC (raw content)
```
