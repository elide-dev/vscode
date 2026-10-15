## Run and debug

Code lenses above a JVM `main` function, and above the entrypoints, scripts and artifacts of `elide.pkl`, run or debug that target with Elide.

**Run with Elide** starts an `elide` task; build diagnostics from the compiler become Problems on the offending file. **Debug with Elide** launches `elide run --debugger` and attaches the JVM debugger, so breakpoints in Kotlin and Java sources are hit.

A Native Image artifact carries the same **Run** and **Debug** pair: both build the artifact first, then run the binary the build produced — in a terminal of its own, or under GDB through the C/C++ extension. Both actions also sit on the artifact's build-target row in the Elide view.

The Elide view in the activity bar lists the same entrypoints, the `build`/`test`/`install` tasks, the build targets of `elide build --inspect`, the source sets and the resolved dependencies.

### Android

Start with **Elide: Check Android Environment** to inspect local tools and devices, even before sync succeeds.
Select a finding for its settings or repair action; inspection does not install SDK components or accept licenses.

After syncing, use **Elide: Select Android Deployment Target…** to choose an APK and device. The status bar shows
the remembered selection used by **Run Android App…** and **Debug Android App…**. A disconnected selection
stops deployment instead of silently switching devices. Debugging requires `android:debuggable="true"` in the APK.

**Open Compose Preview** renders locally without a device. **Show Android Logcat** streams application logs;
Ctrl/Cmd-click a resolvable application stack frame to open its source line.
