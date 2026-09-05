# Elide

Elide build tool integration for Visual Studio Code.

- Feeds the **Kotlin by JetBrains** language server the real project model of any folder containing `elide.pkl`:
  resolved Maven dependencies (with sources/javadoc), source sets, JDK, Kotlin compiler options.
- Re-syncs when `elide.pkl` or the lockfile changes.
- `elide build` / `test` / `install` / `run <entrypoint>` as tasks.
- Debug `elide run --debugger` with breakpoints in Kotlin and Java.

Requires Elide 1.5+ and the `JetBrains.kotlin-server` extension (installed automatically). Settings, tasks, and debug
configuration are documented in the repository README.
