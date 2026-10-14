import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import javax.tools.ToolProvider;

/**
 * Compiles the Kotlin language server plugin against the server's own jars (the class path) with the server's
 * bundled JDK, and packs it as `<jar>`: the server loads plugin classes from `lib/*.jar` only.
 *
 * Arguments: output jar, plugin.xml, Java sources.
 */
class BuildPlugin {
    public static void main(String[] args) throws IOException {
        var compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) throw new IllegalStateException("The Kotlin language server's runtime has no javac.");
        Path jar = Path.of(args[0]);
        Path descriptor = Path.of(args[1]);
        Path classes = Files.createTempDirectory("elide-kotlin-lsp-");
        try {
            build(compiler, jar, descriptor, classes, args);
        } finally {
            try (var files = Files.walk(classes)) {
                for (Path file : (Iterable<Path>) files.sorted((a, b) -> b.compareTo(a))::iterator) Files.delete(file);
            }
        }
    }

    private static void build(javax.tools.JavaCompiler compiler, Path jar, Path descriptor, Path classes, String[] args) throws IOException {
        var options = new ArrayList<>(List.of("-proc:none", "-nowarn", "-classpath", System.getProperty("java.class.path"), "-d", classes.toString()));
        for (int index = 2; index < args.length; index++) options.add(args[index]);
        if (compiler.run(null, System.err, System.err, options.toArray(String[]::new)) != 0)
            throw new IllegalStateException("Cannot compile the Elide plugin against the installed Kotlin language server.");
        try (var out = new JarOutputStream(Files.newOutputStream(jar))) {
            add(out, "META-INF/plugin.xml", descriptor);
            try (var files = Files.walk(classes)) {
                for (Path file : (Iterable<Path>) files.filter(Files::isRegularFile).sorted()::iterator)
                    add(out, classes.relativize(file).toString().replace('\\', '/'), file);
            }
        }
    }

    private static void add(JarOutputStream out, String name, Path file) throws IOException {
        out.putNextEntry(new JarEntry(name));
        Files.copy(file, (OutputStream) out);
        out.closeEntry();
    }
}
