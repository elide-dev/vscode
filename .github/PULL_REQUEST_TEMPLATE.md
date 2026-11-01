## Summary

<!-- What does this change do? -->

## Motivation

<!-- Why is this change needed? Link the related issue, if any. -->

Closes #

## Testing

<!-- Which of the following did you run, and what was the result? -->

- [ ] `bazel test //...` (builds and type-checks everything, packages the `.vsix`, runs the unit tests)
- [ ] `bazel run //:gazelle.check` (BUILD files up to date)
- [ ] `bazel run //packages/vscode:integration_test` (local only)

## Checklist

- [ ] Build, typecheck, and unit tests pass locally.
- [ ] Docs updated for any user-visible change.
- [ ] No generated artifacts committed (`dist/`, `*.vsix`, `workspace.json`).
- [ ] Commit messages follow Conventional Commits.
