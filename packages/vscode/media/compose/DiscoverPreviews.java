import org.objectweb.asm.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;

/** Reads annotation bytecode without loading or executing application classes. */
class DiscoverPreviews {
    private static final String PREVIEW = "androidx.compose.ui.tooling.preview.Preview";
    private static final String PARAMETER = "androidx.compose.ui.tooling.preview.PreviewParameter";
    private static URLClassLoader resources;
    private static final Map<String, List<Annotation>> annotations = new HashMap<>();

    record Settings(List<String> classPath, List<String> projectClassPath, String sourceFile, String packageName) {}
    record Annotation(String type, Map<String, Object> values) {}
    record Preview(String methodFQN, String previewId, String name, Map<String, String> previewParams,
                   List<Map<String, String>> methodParams) {}

    private static AnnotationVisitor readAnnotation(String descriptor, List<Annotation> target) {
        var values = new LinkedHashMap<String, Object>();
        target.add(new Annotation(Type.getType(descriptor).getClassName(), values));
        return valuesVisitor(values);
    }

    private static Object value(Object value) {
        return value instanceof Type type ? type.getClassName() : value;
    }

    private static AnnotationVisitor valuesVisitor(Map<String, Object> values) {
        return new AnnotationVisitor(Opcodes.ASM9) {
            public void visit(String name, Object value) { values.put(name, value(value)); }
            public void visitEnum(String name, String descriptor, String value) { values.put(name, value); }
            public AnnotationVisitor visitArray(String name) {
                var nested = new ArrayList<Annotation>();
                values.put(name, nested);
                return new AnnotationVisitor(Opcodes.ASM9) {
                    public AnnotationVisitor visitAnnotation(String ignored, String descriptor) {
                        return readAnnotation(descriptor, nested);
                    }
                };
            }
        };
    }

    private static List<Annotation> meta(String name) throws IOException {
        if (annotations.containsKey(name)) return annotations.get(name);
        var result = new ArrayList<Annotation>();
        annotations.put(name, result);
        try (var stream = resources.getResourceAsStream(name.replace('.', '/') + ".class")) {
            if (stream != null) new ClassReader(stream).accept(new ClassVisitor(Opcodes.ASM9) {
                public AnnotationVisitor visitAnnotation(String descriptor, boolean visible) {
                    return readAnnotation(descriptor, result);
                }
            }, ClassReader.SKIP_CODE | ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
        }
        return result;
    }

    private static void expand(Annotation annotation, Set<String> visiting, List<Map<String, String>> result) throws IOException {
        if (annotation.type().equals(PREVIEW)) {
            var params = new LinkedHashMap<String, String>();
            annotation.values().forEach((key, value) -> params.put(key, String.valueOf(value)));
            result.add(params);
        } else if (annotation.type().equals(PREVIEW + "$Container")) {
            if (annotation.values().get("value") instanceof List<?> nested)
                for (var item : nested) if (item instanceof Annotation child) expand(child, visiting, result);
        } else if (!annotation.type().startsWith("kotlin.") && !annotation.type().startsWith("java.") && visiting.add(annotation.type())) {
            for (var child : meta(annotation.type())) expand(child, visiting, result);
            visiting.remove(annotation.type());
        }
    }

    private static void scan(byte[] bytes, Settings settings, List<Preview> output) {
        new ClassReader(bytes).accept(new ClassVisitor(Opcodes.ASM9) {
            String className;
            boolean sourceMatches;
            public void visit(int version, int access, String name, String signature, String parent, String[] interfaces) {
                className = name.replace('/', '.');
            }
            public void visitSource(String source, String debug) {
                int separator = className.lastIndexOf('.');
                String pkg = separator < 0 ? "" : className.substring(0, separator);
                sourceMatches = settings.sourceFile().equals(source) && settings.packageName().equals(pkg);
            }
            public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
                if (!sourceMatches || name.startsWith("<") || (access & Opcodes.ACC_SYNTHETIC) != 0) return null;
                var methodAnnotations = new ArrayList<Annotation>();
                var parameters = new TreeMap<Integer, Map<String, String>>();
                return new MethodVisitor(Opcodes.ASM9) {
                    public AnnotationVisitor visitAnnotation(String descriptor, boolean visible) {
                        return readAnnotation(descriptor, methodAnnotations);
                    }
                    public AnnotationVisitor visitParameterAnnotation(int parameter, String descriptor, boolean visible) {
                        if (!Type.getType(descriptor).getClassName().equals(PARAMETER)) return null;
                        var values = new LinkedHashMap<String, String>();
                        parameters.put(parameter, values);
                        return new AnnotationVisitor(Opcodes.ASM9) {
                            public void visit(String key, Object item) { values.put(key, String.valueOf(value(item))); }
                        };
                    }
                    public void visitEnd() {
                        try {
                            var variants = new ArrayList<Map<String, String>>();
                            for (var annotation : methodAnnotations) expand(annotation, new HashSet<>(), variants);
                            if (variants.isEmpty()) return;
                            String method = className + "." + name;
                            String methodId = method + "_" + UUID.nameUUIDFromBytes(descriptor.getBytes(StandardCharsets.UTF_8));
                            for (int index = 0; index < variants.size(); index++) {
                                var params = variants.get(index);
                                String label = params.getOrDefault("name", name);
                                if (label.isEmpty()) label = name;
                                output.add(new Preview(method, methodId + "_" + index, label, params, new ArrayList<>(parameters.values())));
                            }
                        } catch (IOException error) { throw new UncheckedIOException(error); }
                    }
                };
            }
        }, ClassReader.SKIP_CODE | ClassReader.SKIP_FRAMES);
    }

    static List<Preview> discover(Settings settings) throws IOException {
        annotations.clear();
        var urls = new ArrayList<URL>();
        for (String entry : settings.classPath()) urls.add(Path.of(entry).toUri().toURL());
        try (var loader = new URLClassLoader(urls.toArray(URL[]::new), null)) {
            resources = loader;
            var previews = new ArrayList<Preview>();
            var seen = new HashSet<String>();
            for (String entry : settings.projectClassPath()) {
                Path root = Path.of(entry);
                if (Files.isDirectory(root)) {
                    try (var files = Files.walk(root)) {
                        for (Path file : files.filter(p -> p.toString().endsWith(".class")).sorted().toList())
                            if (seen.add(root.relativize(file).toString())) scan(Files.readAllBytes(file), settings, previews);
                    }
                } else {
                    try (var zip = new ZipFile(entry)) {
                        for (var file : zip.stream().filter(e -> e.getName().endsWith(".class")).sorted(Comparator.comparing(ZipEntry::getName)).toList()) {
                            if (!seen.add(file.getName())) continue;
                            try (var stream = zip.getInputStream(file)) { scan(stream.readAllBytes(), settings, previews); }
                        }
                    }
                }
            }
            return previews;
        } finally {
            resources = null;
            annotations.clear();
        }
    }
}
