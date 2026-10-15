package logstat.parser

import java.nio.file.Files
import java.nio.file.Path
import logstat.model.LogEntry
import logstat.model.LogFile

/**
 * Parser for the log format this sample uses:
 *
 * ```
 * 10.0.0.7 [2026-02-11T08:15:04Z] "GET /index.html" 200 5120
 * ```
 *
 * Blank lines and `#` comments are ignored. Anything else that does not match is kept verbatim in
 * [LogFile.malformed] rather than aborting the parse, so a report can mention it.
 */
object LogParser {
  private val LINE = Regex("""^(\S+)\s+\[([^]]+)]\s+"([A-Z]+)\s+(\S+)"\s+(\d{3})\s+(\d+)$""")

  /** Parsed entry for [line], or `null` when it does not match the log format. */
  fun parseLine(line: String): LogEntry? {
    val match = LINE.matchEntire(line.trim()) ?: return null
    val (client, timestamp, method, path, status, bytes) = match.destructured
    return LogEntry(
      client = client,
      timestamp = timestamp,
      method = method,
      path = path,
      // Widths are constrained by the pattern, so neither conversion can overflow.
      status = status.toInt(),
      bytes = bytes.toLong(),
    )
  }

  /** Parse [lines], collecting unparseable ones instead of failing. */
  fun parse(lines: Sequence<String>): LogFile {
    val entries = mutableListOf<LogEntry>()
    val malformed = mutableListOf<String>()
    for (line in lines) {
      val trimmed = line.trim()
      if (trimmed.isEmpty() || trimmed.startsWith("#")) continue
      parseLine(trimmed)?.let(entries::add) ?: malformed.add(trimmed)
    }
    return LogFile(entries, malformed)
  }

  /** Parse the log file at [path]. */
  fun parseFile(path: Path): LogFile = Files.newBufferedReader(path).use { reader ->
    parse(reader.lineSequence())
  }

  /** Parse [text] as log file contents. */
  fun parseText(text: String): LogFile = parse(text.lineSequence())
}
