package logstat.cli

import java.nio.file.Files
import kotlin.io.path.writeText
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
// `model` is not a declared dependency of this project: it arrives with `parser`'s classpath.
import logstat.model.Outcome
import logstat.parser.LogParser

class CliTest {
  private fun run(vararg argv: String): Triple<Int, String, String> {
    val out = StringBuilder()
    val err = StringBuilder()
    val code = Cli.run(argv.toList(), out, err)
    return Triple(code, out.toString(), err.toString())
  }

  private fun log(vararg lines: String) = Files.createTempFile("logstat", ".log").apply {
    writeText(lines.joinToString("\n"))
    toFile().deleteOnExit()
  }

  @Test fun `no arguments prints usage and succeeds`() {
    val (code, out, _) = run()
    assertEquals(0, code)
    assertContains(out, "Usage: logstat <command>")
    assertContains(out, "summary")
  }

  @Test fun `an unknown command is a usage error`() {
    val (code, _, err) = run("frobnicate")
    assertEquals(Cli.EXIT_USAGE, code)
    assertContains(err, "Unknown command 'frobnicate'")
  }

  @Test fun `a missing log file is reported, not thrown`() {
    val (code, _, err) = run("summary", "/nonexistent/access.log")
    assertEquals(Cli.EXIT_USAGE, code)
    assertContains(err, "No such log file")
  }

  @Test fun `summary counts the requests in the given file`() {
    val file = log("""1.1.1.1 [t] "GET /a" 200 5""", """1.1.1.2 [t] "GET /b" 500 0""")
    val (code, out, _) = run("summary", file.toString())
    assertEquals(0, code)
    assertContains(out, "requests")
    assertContains(out, "1 (50.0%)")
  }

  @Test fun `top rejects an unknown dimension and honors --by`() {
    val file = log("""1.1.1.1 [t] "GET /a" 200 5""")
    assertEquals(Cli.EXIT_USAGE, run("top", file.toString(), "--by", "colour").first)
    val (code, out, _) = run("top", file.toString(), "--by=client", "--limit=1")
    assertEquals(0, code)
    assertContains(out, "1.1.1.1")
  }

  @Test fun `help describes a single command`() {
    val (code, out, _) = run("help", "failures")
    assertEquals(0, code)
    assertContains(out, "failures [file] [--min-status n]")
  }

  @Test fun `sibling classpaths are transitive`() {
    // Compiles only because `parser` hands this project `model`, and `model` hands it Guava.
    val parsed = LogParser.parseText("""1.1.1.1 [t] "GET /a" 302 5""")
    assertEquals(Outcome.REDIRECT, parsed.entries.single().outcome)
  }
}
