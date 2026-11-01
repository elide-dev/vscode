## Run and debug

Code lenses above a JVM `main` function, and above the entrypoints, scripts and artifacts of `elide.pkl`, run or debug that target with Elide.

**Run with Elide** starts an `elide` task; build diagnostics from the compiler become Problems on the offending file. **Debug with Elide** launches `elide run --debugger` and attaches the JVM debugger, so breakpoints in Kotlin and Java sources are hit.

A Native Image artifact carries the same **Run** and **Debug** pair: both build the artifact first, then run the binary the build produced — in a terminal of its own, or under GDB through the C/C++ extension. Both actions also sit on the artifact's build-target row in the Elide view.

The Elide view in the activity bar lists the same entrypoints, the `build`/`test`/`install` tasks, the build targets of `elide build --inspect`, the source sets and the resolved dependencies.

### Android SDK tools

**Check Android Environment** inspects an independently installed SDK, platform-tools and connected devices.
It works without a successful sync and never installs components, accepts licenses, builds or deploys an app.

**Show Android Logcat** streams connected-device logs. Use **Filter Android Logcat** to enter an application ID,
read one from an existing APK, or set priority/text filters. Ctrl/Cmd-click a resolvable application stack frame
to open its Kotlin/Java source line.
