# trust-agent example: mixed-language

Demonstrates Trust Agent on a project with TypeScript and Python files, using a hybrid model setup (Anthropic driver + local Ollama projector).

## Prerequisites

Ollama running with a model pulled:

```bash
ollama pull llama3.2
```

## Run

```bash
cd packages/examples/mixed
trust-agent run "Refactor the Engine class to accept a configurable weight parameter"
```

## Structure

```
src/
  core/engine.ts     ← SECRET TypeScript
  core/engine.py     ← SECRET Python
  utils/helpers.ts   ← PUBLIC TypeScript
```

The local model generates L2 semantic projections for the secret files.
The cloud driver (Claude) sees only the projections.
