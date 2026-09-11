## Install the Elide CLI

Everything this extension does runs through the `elide` binary: it resolves the project model, installs dependencies, prints the classpath the Kotlin LSP imports, and builds, runs and tests the project.

Elide 1.5 or newer is required. Install it from the documentation, then reload the window — the extension finds the binary in `$ELIDE_HOME`, in the platform install locations, or on `PATH`.

Set `elide.home` if you keep a distribution somewhere else, for example a checkout you build yourself.
