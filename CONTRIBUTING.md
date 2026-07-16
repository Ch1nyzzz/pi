# Contributing to Evo-Pi

Thanks for your interest. This is a personal fork of [Pi](https://pi.dev) with a
built-in evolution engine. Contributions are welcome — issues and pull requests
are both fine.

## Philosophy

**The core stays minimal.** If a feature does not belong in the core, it should
be an extension. Changes that bloat the core are unlikely to be merged. Even
extension hook points should be well considered to avoid unmaintainable
complexity.

## The one rule

**You must understand your code.** If you cannot explain what your change does
and how it interacts with the rest of the system, it will not be merged.

Using AI to write code is fine. Submitting AI-generated code you have not
reviewed and understood is not. If you use an agent, run it from the repository
root so it picks up `AGENTS.md` automatically and follows the rules there.

## Before submitting a PR

Run both and make sure they pass:

```bash
npm run check
./test.sh
```

Note: the build requires Node.js 22.19 or newer.

Please do not edit `CHANGELOG.md` directly. If you are adding a new provider to
`packages/ai`, see `AGENTS.md` for the required tests.

## Reporting issues

Keep issues short, concrete, and reproducible:

- State the bug or request clearly and explain why it matters.
- Include steps to reproduce, relevant logs, and the affected package/version.
- If you want to implement the change yourself, say so.

For security vulnerabilities, follow [`SECURITY.md`](SECURITY.md) instead of
opening a public issue.
