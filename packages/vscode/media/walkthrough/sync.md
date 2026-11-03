## Sync with the Kotlin language server

A sync runs `elide project export`, `elide install` and `elide classpath`, then hands the project model to the folder's Kotlin language server, which is what makes Kotlin and Java symbols, library sources and Go to Definition work. By default that is the JetBrains Kotlin LSP, which imports a `workspace.json` the sync writes at the workspace folder root. With `elide.kotlinLsp.server` set to `komodo` (experimental), Komodo's language server from the Elide distribution reads the model from the extension's storage instead, and no `workspace.json` is written.

It happens when the window opens and whenever `elide.pkl` or the lockfile changes; the status-bar item shows the current state and opens the Elide menu.

Dependency sources are fetched by default (`elide.install.classifiers`), so Go to Definition steps into library code.
