package logstat.cli

import java.nio.file.Files
import java.nio.file.Path
import logstat.model.LogFile
import logstat.parser.LogParser
import logstat.report.Dimension
import logstat.report.Reports

/** One subcommand of the `logstat` CLI. */
sealed interface Command {
  /** Name the user types. */
  val name: String

  /** One-line description, shown by `logstat help`. */
  val summary: String

  /** Argument syntax, shown by `logstat help`. */
  val usage: String

  /** Run against already-split [args], writing to [out]. */
  fun run(args: Arguments, out: Appendable)
}

/** Commands that read a log file given as their first positional argument. */
sealed class LogCommand : Command {
  protected fun logFile(args: Arguments): LogFile {
    val path = Path.of(args.positional(0, DEFAULT_LOG)!!)
    if (!Files.isRegularFile(path)) {
      throw UsageError("No such log file: $path (pass a path, or run from the workspace root)")
    }
    return LogParser.parseFile(path)
  }

  protected companion object {
    const val DEFAULT_LOG: String = "data/access.log"
  }
}

/** `summary [file]` — overall volume, clients, bytes and outcome breakdown. */
object SummaryCommand : LogCommand() {
  override val name: String = "summary"
  override val summary: String = "Overall request volume and outcome breakdown"
  override val usage: String = "summary [file]"

  override fun run(args: Arguments, out: Appendable) {
    out.append(Reports.summary(logFile(args)))
  }
}

/** `top [file] [--by dimension] [--limit n]` — ranked counts along one dimension. */
object TopCommand : LogCommand() {
  override val name: String = "top"
  override val summary: String = "Most frequent paths, statuses, clients or methods"
  override val usage: String = "top [file] [--by ${Dimension.names().joinToString("|")}] [--limit n]"

  override fun run(args: Arguments, out: Appendable) {
    val requested = args.string("by", "path")!!
    val dimension = Dimension.of(requested)
      ?: throw UsageError("Unknown dimension '$requested'; expected one of ${Dimension.names().joinToString(", ")}")
    val limit = args.int("limit", 5)
    if (limit <= 0) throw UsageError("--limit expects a positive number, got $limit")
    out.append(Reports.top(logFile(args), dimension, limit))
  }
}

/** `failures [file] [--min-status n]` — every failing request. */
object FailuresCommand : LogCommand() {
  override val name: String = "failures"
  override val summary: String = "Requests that failed, optionally filtered by status"
  override val usage: String = "failures [file] [--min-status n]"

  override fun run(args: Arguments, out: Appendable) {
    out.append(Reports.failures(logFile(args), args.int("min-status", 400)))
  }
}

/** `help [command]` — usage for every command, or for one. */
object HelpCommand : Command {
  override val name: String = "help"
  override val summary: String = "Show this help"
  override val usage: String = "help [command]"

  override fun run(args: Arguments, out: Appendable) {
    when (val requested = args.positional(0)) {
      null -> out.append(Cli.usage())
      else -> {
        val command = Cli.command(requested) ?: throw UsageError("Unknown command '$requested'")
        out.append("logstat ${command.usage}\n  ${command.summary}\n")
      }
    }
  }
}
