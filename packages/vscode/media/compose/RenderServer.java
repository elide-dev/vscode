import com.android.layoutlib.LayoutlibClassLoader;
import com.android.tools.render.*;
import com.android.tools.render.common.*;
import com.android.tools.render.compose.ComposeScreenshot;
import com.android.resources.ResourceFolderType;
import com.android.tools.configurations.Configuration;
import com.android.tools.preview.PreviewConfigurationKt;
import com.android.tools.rendering.RenderLogger;
import com.android.tools.rendering.RenderResult;
import com.android.tools.rendering.RenderService;
import com.android.tools.rendering.RenderTask;
import com.android.tools.rendering.parsers.RenderXmlFileSnapshot;
import com.android.tools.rendering.classloading.FilteringClassLoader;
import com.android.tools.rendering.classloading.FirewalledResourcesClassLoader;
import com.google.common.cache.AbstractCache;
import com.google.gson.*;
import com.intellij.openapi.util.Disposer;
import java.io.*;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.awt.image.BufferedImage;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.Callable;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipFile;
import javax.imageio.ImageIO;
import javax.imageio.IIOImage;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.FileImageOutputStream;

/** One layoutlib/framework per session; project classes and discovery state never cross generations. */
class RenderServer {
    private static final Gson JSON = new Gson();
    private static final int MAX_LINE = 8 * 1024 * 1024;
    private static final ClassValue<Method> COMPOSE_DISPOSE = new ClassValue<>() {
        @Override protected Method computeValue(Class<?> type) {
            for (Method method : type.getMethods()) {
                String name = method.getName();
                if ((name.equals("dispose") || name.startsWith("dispose$"))
                        && method.getParameterCount() == 0 && method.getReturnType() == void.class)
                    return method;
            }
            throw new IllegalStateException("ComposeViewAdapter.dispose is unavailable.");
        }
    };
    private final String layoutlibPath;
    private Renderer renderer;
    private Inputs inputs;
    private long resourceModified;
    private DefaultModuleClassLoader dependencies;
    private DefaultModuleClassLoader generationLoader;
    private List<String> reloadableClassPath;
    private Map<String, Integer> previousOwners = Map.of();
    private final Field sharedLoaders;
    private final Field renderServiceField;
    private final Field baseConfigurationField;
    private final Method postProcessImage;
    private final Method extractError;
    private final ImageWriter pngWriter = ImageIO.getImageWritersByFormatName("png").next();
    private final ImageWriteParam pngParameters = pngWriter.getDefaultWriteParam();

    record Inputs(List<String> classPath, List<String> projectClassPath, String namespace, String resourceApkPath) {}
    record Request(long id, List<String> classPath, List<String> projectClassPath, String namespace,
                   String resourceApkPath, String sourceFile, String packageName, String outputFolder,
                   int shardIndex, int shardCount, Map<String, Double> weights) {}

    RenderServer(String layoutlibPath) throws ReflectiveOperationException {
        this.layoutlibPath = layoutlibPath;
        // alpha16's public clearCache is a no-op and its cache miss returns the original preloader.
        // Fail at startup on incompatible runtimes rather than silently displaying stale project code.
        sharedLoaders = StandaloneModuleClassLoaderManager.class.getDeclaredField("sharedClassLoaders");
        sharedLoaders.setAccessible(true);
        renderServiceField = Renderer.class.getDeclaredField("renderService");
        baseConfigurationField = Renderer.class.getDeclaredField("baseConfiguration");
        postProcessImage = Renderer.class.getDeclaredMethod("postProcessRenderedImage", Configuration.class, RenderResult.class);
        extractError = Renderer.class.getDeclaredMethod("extractError", RenderResult.class, BufferedImage.class);
        renderServiceField.setAccessible(true);
        baseConfigurationField.setAccessible(true);
        postProcessImage.setAccessible(true);
        extractError.setAccessible(true);
        pngParameters.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
        // PNG remains lossless; favor interactive latency over maximum file compression.
        pngParameters.setCompressionQuality(0.9f);
    }

    private static boolean isToolingClass(String name) {
        String simpleName = name.substring(name.lastIndexOf('/') + 1);
        return name.startsWith("androidx/compose/ui/tooling/")
                && !name.startsWith("androidx/compose/ui/tooling/preview/")
                && name.endsWith(".class") && !simpleName.equals("R.class") && !simpleName.startsWith("R$");
    }

    private static boolean containsTooling(String entry) throws IOException {
        Path path = Path.of(entry);
        if (Files.isDirectory(path)) {
            Path tooling = path.resolve("androidx/compose/ui/tooling");
            if (!Files.isDirectory(tooling)) return false;
            try (var files = Files.walk(tooling)) {
                return files.anyMatch(file -> isToolingClass(path.relativize(file).toString().replace(File.separatorChar, '/')));
            }
        }
        try (var zip = new ZipFile(entry)) {
            return zip.stream().anyMatch(item -> isToolingClass(item.getName()));
        }
    }

    private void closeRenderer() throws Exception {
        if (renderer == null) return;
        var previous = renderer;
        renderer = null;
        try {
            previous.getModule().dispose();
        } finally {
            previous.close();
        }
    }

    private void prepare(Inputs next) throws Exception {
        long modified = Files.getLastModifiedTime(Path.of(next.resourceApkPath())).toMillis();
        if (!next.equals(inputs) || modified != resourceModified) {
            closeRenderer();
            var project = new HashSet<>(next.projectClassPath());
            var stable = new ArrayList<String>();
            var reloadable = new ArrayList<String>();
            for (String entry : next.classPath()) {
                // Tooling reflectively resolves preview/provider classes through its defining loader.
                // It must live beside the fresh project classes, not in their long-lived parent.
                if (project.contains(entry) || containsTooling(entry)) reloadable.add(entry);
                else stable.add(entry);
            }
            var parent = new FirewalledResourcesClassLoader(FilteringClassLoader.allowedPrefixes(
                    new LayoutlibClassLoader(RenderServer.class.getClassLoader()),
                    ClassLoaderConstantsKt.getALLOWED_PACKAGES_FROM_PARENT()));
            dependencies = new DefaultModuleClassLoader(parent, stable, List.of());
            reloadableClassPath = reloadable;
            renderer = new RenderEnvironmentBootstrapper(null, next.resourceApkPath(), next.namespace(),
                    next.classPath(), next.projectClassPath(), layoutlibPath, List.of(), List.of()).bootstrap();
            renderer.getModule().getEnvironment().getModuleClassLoaderManager().close();
            inputs = next;
            resourceModified = modified;
        }
        // Stable classes/resources already resolve through the parent; don't recreate their URL
        // loaders and indexes for every generation or enumerate the same service resources twice.
        generationLoader = new DefaultModuleClassLoader(dependencies, reloadableClassPath, next.projectClassPath());
        // The upstream manager also shares one loader across the parent keys of a render. Replacing
        // the whole cache avoids its preloader fallback; private requests still create fresh loaders.
        sharedLoaders.set(renderer.getModule().getEnvironment().getModuleClassLoaderManager(),
                new AbstractCache<ClassLoader, DefaultModuleClassLoader>() {
                    @Override public DefaultModuleClassLoader getIfPresent(Object key) { return generationLoader; }
                    @Override public DefaultModuleClassLoader get(ClassLoader key,
                            Callable<? extends DefaultModuleClassLoader> ignored) {
                        return Objects.requireNonNull(generationLoader, "No active preview generation.");
                    }
                });
    }

    private static void disposeComposeViews(List<com.android.ide.common.rendering.api.ViewInfo> views) {
        for (var info : views) {
            Object view = info.getViewObject();
            if (view != null && view.getClass().getName().equals("androidx.compose.ui.tooling.ComposeViewAdapter")) {
                try {
                    COMPOSE_DISPOSE.get(view.getClass()).invoke(view);
                } catch (ReflectiveOperationException failure) {
                    throw new IllegalStateException("Unable to dispose Compose preview composition.", failure);
                }
            }
            if (info.getChildren() != null) disposeComposeViews(info.getChildren());
        }
    }

    private List<PreviewScreenshotResult> renderPreview(ComposeScreenshot screenshot, String outputFolder) throws Exception {
        var source = renderer.getModule();
        var element = screenshot.toPreviewElement(source);
        var layouts = element.resolveXmlLayouts().iterator();
        var results = new ArrayList<PreviewScreenshotResult>();
        var service = (RenderService) renderServiceField.get(renderer);
        var base = (Configuration) baseConfigurationField.get(renderer);
        int index = 0;
        while (layouts.hasNext()) {
            String xml = layouts.next();
            String relative = screenshot.getPreviewId().replace('.', '/') + "_" + index++ + ".png";
            // A task owns its module disposable. Share resource repositories, not disposable state.
            var module = new StandaloneRenderModelModule(source.getResourceRepositoryManager(), source.getInfo(),
                    source.getAndroidPlatform(), source.getModuleKey(), source.getDependencies(), source.getProject(),
                    source.getResourcePackage(), source.getEnvironment(), source.getResourceIdManager(), inputs.resourceApkPath());
            var lifetime = Disposer.newCheckedDisposable();
            RenderTask task = null;
            RenderResult result = null;
            try {
                var configuration = base.clone();
                PreviewConfigurationKt.applyTo(element, configuration, ignored -> null);
                var logger = new RenderLogger();
                task = service.taskBuilder(module, configuration, logger).build(lifetime).get(30, TimeUnit.SECONDS);
                if (task == null) {
                    result = RenderResult.createRenderTaskErrorResult(module, () -> null, null, logger);
                } else {
                    task.setXmlFile(new RenderXmlFileSnapshot(renderer.getProject(), "layout.xml", ResourceFolderType.LAYOUT, xml));
                    result = task.render().get(30, TimeUnit.SECONDS);
                }
                var image = (BufferedImage) postProcessImage.invoke(renderer, configuration, result);
                var error = (ScreenshotError) extractError.invoke(renderer, result, image);
                if (image != null && error == null) {
                    Path output = Path.of(outputFolder).resolve(relative);
                    Files.createDirectories(output.getParent());
                    try (var outputStream = new FileImageOutputStream(output.toFile())) {
                        pngWriter.setOutput(outputStream);
                        try {
                            pngWriter.write(null, new IIOImage(image, null, null), pngParameters);
                        } finally {
                            pngWriter.setOutput(null);
                        }
                    }
                }
                results.add(new PreviewScreenshotResult(screenshot.getPreviewId(), screenshot.getMethodFQN(), relative, error));
            } catch (Exception failure) {
                results.add(new PreviewScreenshotResult(screenshot.getPreviewId(), screenshot.getMethodFQN(), relative,
                        new ScreenshotError(failure)));
            } finally {
                try {
                    if (task != null && result != null) {
                        var rendered = result;
                        task.runAsyncRenderActionWithSession(() -> disposeComposeViews(rendered.getRootViews()),
                                5, TimeUnit.SECONDS).get(10, TimeUnit.SECONDS);
                        // Cancellation resumes on AndroidUiDispatcher; run it before layoutlib clears
                        // the session's Handler queue, or its stable dispatcher retains the old views.
                        task.executeCallbacks(0).get(10, TimeUnit.SECONDS);
                    }
                } finally {
                    if (result != null) Disposer.dispose(result);
                    Disposer.dispose(lifetime);
                    if (task != null) task.disposeAsync().get(10, TimeUnit.SECONDS);
                    else module.dispose();
                }
            }
        }
        return results;
    }

    private JsonObject render(Request request) throws Exception {
        if (request.shardCount() < 1 || request.shardCount() > 6
                || request.shardIndex() < 0 || request.shardIndex() >= request.shardCount())
            throw new IllegalArgumentException("Invalid renderer shard.");
        var previews = DiscoverPreviews.discover(new DiscoverPreviews.Settings(request.classPath(),
                request.projectClassPath(), request.sourceFile(), request.packageName()));
        var results = new ArrayList<PreviewScreenshotResult>();
        // Small files need only one layoutlib. Balance larger galleries by the previous images'
        // provider expansion counts and pixel area; adding a preview never changes gallery order.
        int shards = previews.size() < 6 ? 1 : request.shardCount();
        var weighted = new ArrayList<>(previews);
        weighted.sort(Comparator.comparingDouble((DiscoverPreviews.Preview preview) ->
                request.weights().getOrDefault(preview.previewId(), 1.0)).reversed());
        var owners = new HashMap<String, Integer>();
        var loads = new double[shards];
        for (var preview : weighted) {
            int owner = previousOwners.getOrDefault(preview.previewId(), 0);
            if (owner >= shards) owner = 0;
            // Equal loads retain affinity, including provider/device initialization caches.
            for (int index = 0; index < shards; index++) if (loads[index] < loads[owner]) owner = index;
            owners.put(preview.previewId(), owner);
            loads[owner] += request.weights().getOrDefault(preview.previewId(), 1.0);
        }
        previousOwners = owners;
        if (!previews.isEmpty() && request.shardIndex() < shards) {
            try {
                prepare(new Inputs(request.classPath(), request.projectClassPath(), request.namespace(), request.resourceApkPath()));
                for (var preview : previews) {
                    if (owners.get(preview.previewId()) != request.shardIndex()) continue;
                    results.addAll(renderPreview(new ComposeScreenshot(preview.methodFQN(), preview.methodParams(),
                            preview.previewParams(), preview.previewId(), null), request.outputFolder()));
                }
            } finally {
                // alpha16 dispose() is currently a no-op; dropping the cache's strong reference is
                // essential to permit class unloading after each task and composition are disposed.
                if (generationLoader != null) generationLoader.dispose();
                generationLoader = null;
            }
        }
        var serialized = new StringWriter();
        JsonSerializationKt.writePreviewRenderingResult(serialized, new PreviewRenderingResult(null, results));
        var response = JsonParser.parseString(serialized.toString()).getAsJsonObject();
        response.addProperty("id", request.id());
        response.add("previews", JSON.toJsonTree(previews));
        return response;
    }

    private static String readLine(Reader input) throws IOException {
        var line = new StringBuilder();
        int character;
        while ((character = input.read()) != -1) {
            if (character == '\n') return line.toString();
            if (line.length() == MAX_LINE) throw new IOException("Compose renderer request exceeds protocol limit.");
            line.append((char) character);
        }
        if (!line.isEmpty()) throw new EOFException("Incomplete Compose renderer request.");
        return null;
    }

    public static void main(String[] args) throws Exception {
        var protocol = new PrintWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8), true);
        System.setOut(System.err);
        var server = new RenderServer(args[0]);
        protocol.println("{\"ready\":true}");
        var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = readLine(input)) != null) {
            Request request = JSON.fromJson(line, Request.class);
            try {
                String response = JSON.toJson(server.render(request));
                if (response.length() > MAX_LINE) throw new IOException("Compose renderer response exceeds protocol limit.");
                protocol.println(response);
            } catch (Throwable failure) {
                failure.printStackTrace(System.err);
                var response = new JsonObject();
                response.addProperty("id", request.id());
                response.addProperty("globalError", failure.toString());
                protocol.println(JSON.toJson(response));
                // The host terminates the JVM after a failed request; never reuse uncertain native state.
                return;
            }
        }
        server.closeRenderer();
        server.pngWriter.dispose();
    }
}
