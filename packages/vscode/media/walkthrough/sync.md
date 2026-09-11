## Sync with the Kotlin LSP

A sync runs `elide manifest`, `elide install` and `elide classpath`, then writes a `workspace.json` at the workspace folder root. The JetBrains Kotlin LSP imports that file, which is what makes Kotlin and Java symbols, library sources and Go to Definition work.

It happens when the window opens and whenever `elide.pkl` or the lockfile changes; the status-bar item shows the current state and opens the Elide menu.

Dependency sources are fetched by default (`elide.install.classifiers`), so Go to Definition steps into library code.
