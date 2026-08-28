# Contributing to SkVM

Thanks for your interest in contributing! SkVM is a research project from SJTU-IPADS, and we welcome bug reports, feature ideas, and pull requests from the community.

This document describes the contribution workflow, local development setup, and the conventions we follow. The high-level project overview lives in [`README.md`](./README.md) — please skim that first if you're new to SkVM.

> Both English and Chinese are welcome in issues and PRs. Maintainers respond in either.

---

## Workflow at a glance

```
  idea ──┬───────────────────────────────► open PR ──► review ──► merge
         │                                    ▲
         └─ want design feedback first? ──────┘
            open an issue (optional)
```

**Rule of thumb:**

- **Open a pull request directly.** That holds for bug fixes, documentation, tests, and cleanups, and equally for new features, refactors, and changes to CLI flags, on-disk layouts (`~/.skvm/`, `skvm-data/`), or the adapter / provider interfaces. No tracking issue is required for any of them.
- **File an issue first when you want to,** not because the process demands it. It is worth doing when you would rather not write the code twice — a large or speculative change, an approach you are unsure fits the architecture, or a question you want answered before you start.

A PR is a concrete proposal, and a concrete proposal is easier to discuss than a description of one. If a reviewer thinks the design needs its own conversation, they will say so on the PR — you will not be asked to close it and start again in an issue.

---

## Filing an issue

Issues are for things a PR cannot carry on its own: a bug you are not fixing yourself, an idea you would like someone else to pick up, or a design question you want settled before you write code. We provide three templates under [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/):

- **Bug report** — something is broken or behaves unexpectedly.
- **Feature request** — propose a new capability (optionally before sending a PR).
- **Question / discussion** — open-ended design or usage questions.

A good issue includes:

- What you tried, what you expected, and what actually happened.
- The exact CLI invocation, model id, and adapter when relevant.
- The SkVM version (`bun run skvm --version` or commit SHA) and runtime (Bun version, OS).
- A minimal reproduction if possible — even a copy-pasted log or a stripped-down skill helps.

For feature requests, please describe the **use case** before the proposed implementation. We may suggest a different shape that fits the existing architecture better.

---

## Local development

SkVM is a TypeScript + Bun project with no build step for development. Sources run directly via `bun run`.

```bash
bun run skvm <cmd>                # run the CLI from source (src/index.ts)
bun test                          # run the full test suite
bun test test/compiler/guard.test.ts    # run a single test file
bun test -t "pattern"             # filter tests by name
bunx tsc --noEmit                 # typecheck
bun run build:binary              # compile dist/skvm single-file binary (current host)
bun run build:all                 # cross-compile all 4 release targets → dist/*.tar.gz
```

The `bunfig.toml` preload redirects `SKVM_CACHE` to a temp dir so tests never touch `~/.skvm`. Integration scripts under `test/integration/live-*.ts` hit real LLMs and are run manually — they aren't picked up by `bun test`.

The benchmark dataset is a git submodule:

```bash
git submodule update --init       # populates skvm-data/
```

## Submitting a pull request

1. **Fork** the repo and create a branch off `main`. Name it after the topic, e.g. `fix/jit-optimize-empty-history`, `feat/m9-search-index`.
2. **Link an issue if there is one.** Put `Closes #123` or `Refs #123` in the PR description. There is no requirement that one exists.
3. **Keep PRs focused.** One logical change per PR. If you find unrelated cleanups along the way, send them as a separate PR.
4. **Run the local checks** before pushing:

   ```bash
   bunx tsc --noEmit       # typecheck
   bun test                # full test suite
   ```

   Both must pass. If your change touches a CLI command, exercise it manually and include the invocation in the PR description.

5. **Add tests** for new behavior. SkVM's test suite never touches `~/.skvm` (see `bunfig.toml`); follow the existing patterns under `test/`.
6. **Update docs** when you change user-visible behavior — `README.md`, `README.zh-CN.md`, or deep notes under `docs/skvm/` as appropriate.
7. **Open the PR** using the template. Fill in all sections; reviewers rely on them.

---

## Commit message style

Use the prefix style already established in `git log`:

```
<scope>: <short summary in lowercase>
```

Examples (real commits from this repo):

```
cli-config: cap config init backups at 5 most recent
providers+hermes: deepseek thinking-mode echo + hermes managed-mode fix
bind-env: fix multi-line import capture and sanitize hallucinated deps
docs: capture aot-compile pass-registry follow-up debt
```

Guidelines:

- The scope is the module or area being touched (e.g. `compiler`, `jit-optimize`, `bench`, `cli-config`, `docs`, `tests`). Combine scopes with `+` when a change genuinely spans two areas.
- Keep the summary under ~72 characters. Use the imperative mood (`fix`, `add`, `bump`) — not past tense.
- Use the body to explain **why**, not what. The diff already shows what.
- One logical change per commit. Squash fixup commits before merging when possible.

We do **not** use Conventional Commits prefixes (`feat:`, `fix:`, `chore:`). Stick with the scope-style above.

---

## Code style and conventions

- All imports end in `.ts` (required by `verbatimModuleSyntax`).
- Prefer `Bun.file()` / `Bun.write()` over `node:fs`.
- Zod schemas live next to the types they validate in `types.ts` files; all JSON artifacts get a schema.
- CLI flags are `--key=value` only — no space-separated form.
- Model ids always carry a `<provider>/` prefix (e.g. `anthropic/claude-sonnet-4.6`, `openrouter/qwen/qwen3-30b`). Unprefixed ids error out — there is no fallback.
- When referring to Anthropic models in code, ids, or configs, use dot form (`claude-sonnet-4.6`), not dash form.
- Every user-facing feature needs a CLI entry point that an agent can drive headlessly. The CLI is the contract that subsystems are tested against.
- Plans and design notes go under `docs/skvm/`, not a flat `docs/`.
- Tests must never touch the real cache — `SKVM_CACHE` is redirected to a temp dir via the bunfig preload.

---

## Reporting security issues

Please **do not** file security issues in the public tracker. Email the maintainers (see `package.json` / repo metadata) with a description of the vulnerability and a reproduction. We will acknowledge within a few business days and coordinate a fix and disclosure timeline with you.

---

## License

By contributing to SkVM you agree that your contributions will be licensed under the same license as the project (see [`LICENSE`](./LICENSE)).
