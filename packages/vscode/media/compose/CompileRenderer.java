import java.util.ArrayList;
import java.util.List;
import javax.tools.ToolProvider;

/** Uses the selected java executable's own compiler, including when java is on PATH. */
class CompileRenderer {
    public static void main(String[] args) {
        var compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) throw new IllegalStateException("Compose Preview requires a JDK 17+ with javac.");
        var options = new ArrayList<>(List.of("--release", "17", "-proc:none", "-classpath",
                System.getProperty("java.class.path"), "-d", args[0]));
        for (int index = 1; index < args.length; index++) options.add(args[index]);
        if (compiler.run(null, System.err, System.err, options.toArray(String[]::new)) != 0)
            throw new IllegalStateException("Cannot compile the persistent Compose renderer against the installed runtime.");
    }
}
