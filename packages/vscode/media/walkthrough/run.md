## Run and debug

Code lenses above a JVM `main` function, and above the entrypoints, scripts and artifacts of `elide.pkl`, run or debug that target with Elide.

**Run with Elide** starts an `elide` task; build diagnostics from the compiler become Problems on the offending file. **Debug with Elide** launches `elide run --debugger` and attaches the JVM debugger, so breakpoints in Kotlin and Java sources are hit.

A Native Image artifact also offers **Build & Run**: it builds the artifact and then runs the binary the build produced, in a terminal of its own. The same action sits on the artifact's build-target row in the Elide view.

The Elide view in the activity bar lists the same entrypoints, the `build`/`test`/`install` tasks, the build targets of `elide build --inspect`, the source sets and the resolved dependencies.
