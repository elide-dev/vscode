package logstat.report

import logstat.model.LogEntry
import logstat.model.LogFile
import logstat.model.Outcome

/** A dimension a log file can be ranked by. */
enum class Dimension(private val selector: (LogEntry) -> String) {
  PATH({ it.path }),
  STATUS({ it.status.toString() }),
  CLIENT({ it.client }),
  METHOD({ it.method });

  /** Key of [entry] along this dimension. */
  operator fun invoke(entry: LogEntry): String = selector(entry)

  companion object {
    /** Dimension named [name], case-insensitively; `null` when there is no such dimension. */
    fun of(name: String): Dimension? = entries.firstOrNull { it.name.equals(name, ignoreCase = true) }

    /** Every dimension name, lowercased, for help text and error messages. */
    fun names(): List<String> = entries.map { it.name.lowercase() }
  }
}

/** Text reports over a parsed [LogFile]. */
object Reports {
  /** Counts along [dimension], highest first, ties broken by key for a stable report. */
  fun rank(file: LogFile, dimension: Dimension): List<Pair<String, Int>> =
    file.entries
      .groupingBy(dimension::invoke)
      .eachCount()
      .entries
      .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
      .map { (key, count) -> key to count }

  /** Overall counts: volume, distinct clients, bytes, and the outcome breakdown. */
  fun summary(file: LogFile): String {
    if (file.size == 0) return "No requests parsed.\n"
    val failures = file.failures().size
    val table = Table("metric", "value")
    table.row("requests", file.size)
    table.row("clients", file.clients().size)
    table.row("bytes", file.bytes)
    table.row("failures", "%d (%.1f%%)".format(failures, 100.0 * failures / file.size))
    if (file.malformed.isNotEmpty()) table.row("unparsed lines", file.malformed.size)
    for (outcome in Outcome.entries) {
      val count = file.entries.count { it.outcome == outcome }
      if (count > 0) table.row(outcome.label, count)
    }
    return table.render()
  }

  /** The [limit] most frequent keys along [dimension]. */
  fun top(file: LogFile, dimension: Dimension, limit: Int): String {
    require(limit > 0) { "limit must be positive, got $limit" }
    val ranked = rank(file, dimension).take(limit)
    if (ranked.isEmpty()) return "No requests parsed.\n"
    val table = Table(dimension.name.lowercase(), "requests", "share")
    for ((key, count) in ranked) {
      table.row(key, count, "%.1f%%".format(100.0 * count / file.size))
    }
    return table.render()
  }

  /** Every failing request with a status of at least [minStatus]. */
  fun failures(file: LogFile, minStatus: Int): String {
    val matching = file.failures().filter { it.status >= minStatus }
    if (matching.isEmpty()) return "No requests with status >= $minStatus.\n"
    val table = Table("status", "method", "path", "client", "when")
    for (entry in matching) {
      table.row(entry.status, entry.method, entry.path, entry.client, entry.timestamp)
    }
    return table.render()
  }
}
