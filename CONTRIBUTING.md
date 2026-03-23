# Contributing to Trust Agent

Thank you for contributing! This document covers the development workflow, how to add language support, extend the Guard, and add new tools.

---

## Development setup

```bash
git clone https://github.com/microarch-flow/trust-agent.git
cd trust-agent
bun install
bun test         # run the full test suite
```

All 152+ tests should pass before you open a pull request.

---

## Running tests

```bash
bun test                                   # all tests
bun test packages/eval/src/e2e.test.ts     # end-to-end only
bun test packages/eval/src/regression.test.ts  # regression suite
bun test --watch                           # watch mode
```

Tests use [Bun's built-in test runner](https://bun.sh/docs/cli/test). No external test server needed — all file I/O uses the `fixtures/` directory.

---

## Package structure

```
packages/
  core/       — TrustGate, ProjectionEngine, Guard, AuditLogger, Orchestrator
  cli/        — CLI commands (run, init, validate, status), CliReporter
  eval/       — All test suites (unit, integration, e2e, regression, behavior)
```

---

## Adding a new language

To add projection support for a new programming language (e.g., Rust):

**1. Ensure treesitter has a grammar for it.**
Check `packages/core/src/projection/` for which treesitter parsers are already loaded.

**2. Add a fixture file** under `packages/eval/fixtures/sample-project/src/`:

```
src/core/engine.rs      ← secret (matches src/core/**)
src/utils/helpers.rs    ← public
```

Include realistic-looking functions, a "secret" constant, and at least one struct/class.

**3. Verify projection works:**

```bash
trust-agent validate --test-projection packages/eval/fixtures/sample-project/src/core/engine.rs
```

The L1 projection should show function signatures but not the secret constant value.

**4. Add regression test cases** in `packages/eval/src/regression.test.ts` under the "language fixture files" describe block:

```typescript
test("Rust core file is classified as secret", () => {
  const rsPath = join(FIXTURE_ROOT, "src/core/engine.rs")
  if (existsSync(rsPath)) {
    expect(assetMap.getLevel(rsPath)).toBe("secret")
  }
})
```

---

## Adding a Guard rule

The Guard has three layers. To add a new detection:

**Layer 1 — Token match** (`packages/core/src/guard/guard.ts`):
Add patterns to `tokenPatterns` or extend `tokenMatch()` to cover new secret shapes (e.g., AWS ARNs, private key blocks).

**Layer 2 — Structure fingerprint**:
Improve `structureSimilarity()` in the Guard to handle new AST node types.

**Layer 3 — Meta guard**:
Update the meta-guard system prompt in `packages/core/src/guard/guard.ts` to describe new secret categories to watch for.

Always add unit tests in `packages/eval/src/guard.test.ts` covering:
- A string that should be flagged
- A similar-looking string that should NOT be flagged (avoid false positives)

---

## Adding a new tool

Tools are defined in `packages/core/src/orchestrator/tools.ts`.

**1. Create a `ToolDefinition`:**

```typescript
function createMyTool(): ToolDefinition {
  return {
    name: "my_tool",
    description: "What this tool does — shown to the LLM.",
    parameters: {
      type: "object",
      properties: {
        arg1: { type: "string", description: "First argument" },
      },
      required: ["arg1"],
    },
    execute: async (args) => {
      const result = doSomething(args.arg1 as string)
      return { output: result }
    },
  }
}
```

**2. Register it in `createBuiltinTools()`:**

```typescript
export function createBuiltinTools(...): ToolDefinition[] {
  return [
    createReadTool(),
    // ... existing tools ...
    createMyTool(),   // ← add here
  ]
}
```

**3. Update the tool guide** in `packages/core/src/orchestrator/prompts/tool-guide.md` with a new row in the tool table.

**4. Add tests** in `packages/eval/src/` verifying the tool executes correctly and that the Gate handles it appropriately (PASS for public args, appropriate verdict for secret-touching args).

---

## Code style

- TypeScript, strict mode
- No `any` in new production code (test files may use `any`)
- Prefer `const` over `let`
- No default exports — use named exports
- File names: `kebab-case.ts`
- Test files: `*.test.ts` co-located under `packages/eval/src/`

---

## Pull request checklist

- [ ] `bun test` passes with 0 failures
- [ ] New functionality has tests
- [ ] Config changes documented in `doc/config-reference.md`
- [ ] User-visible changes noted in `CHANGELOG.md` (if it exists)
- [ ] No hardcoded API keys or tokens
