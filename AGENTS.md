# Repository Guidelines

## Project Structure & Module Organization
This repository is a Bun + TypeScript monorepo. Core logic lives in `packages/core/src`, including `gate/`, `guard/`, `projection/`, `hightrust/`, `workspace/`, and `orchestrator/`. CLI entrypoints and commands live in `packages/cli/src`, with command handlers under `packages/cli/src/commands`. Tests and evaluation fixtures live in `packages/eval`: use `src/*.test.ts` for test suites and `fixtures/sample-project/` for realistic sample inputs. Design and user documentation lives under `doc/`.

## Build, Test, and Development Commands
Install dependencies with `bun install`. Use `bun run build` to type-check and build the workspace with `tsc --build`. Run `bun test` for the full suite, or scope runs with commands such as `bun test packages/eval/src/e2e.test.ts` and `bun test packages/eval/src/regression.test.ts`. For CLI packaging, use `bun run --filter @trust-proxy/cli build` or `bun run --filter @trust-proxy/cli build:all`.

## Coding Style & Naming Conventions
Use strict TypeScript and prefer named exports. Do not introduce new `any` types in production code. Prefer `const` over `let` unless mutation is required. Keep source files in `kebab-case.ts`; test files should end in `.test.ts`. Follow the existing 2-space indentation and keep modules small and purpose-specific. The main lint gate is `bun run lint`, which runs `tsc --noEmit`.

## Testing Guidelines
Tests use Bun's built-in runner. Add or update tests in `packages/eval/src` for every behavior change, especially around Guard, Gate, projection, and CLI flows. Name tests after the observable behavior, for example `guard-layers.test.ts` or `regression.test.ts`. When adding language or policy coverage, extend fixtures under `packages/eval/fixtures/sample-project/` and verify with targeted `bun test` runs before running the full suite.

## Commit & Pull Request Guidelines
The current history starts with concise, imperative summaries such as `Initial release: Trust Proxy v0.1.0`. Follow that pattern: short subject lines, focused commits, and one logical change per commit. PRs should include a clear description, linked issue when applicable, test evidence, and documentation updates for any config or user-visible behavior changes. Do not commit secrets, API keys, or real sensitive fixtures.

## Security & Agent Notes
Treat `secret`-handling paths as security-sensitive code. Prefer fixture-based tests over real data, and document policy/config changes in `doc/config-reference.md` or related docs. When modifying prompts or guard logic, include regression coverage to prove that protected source content still does not leak.
