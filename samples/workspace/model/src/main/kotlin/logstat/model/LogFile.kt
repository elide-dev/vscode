package logstat.model

import com.google.common.collect.ImmutableList

/**
 * An immutable, parsed log file: the records that were understood, plus the lines that were not.
 *
 * Guava appears in this project's *public* API on purpose: the `cli` project never declares Guava
 * or `model`, yet compiles against both, because depending on a workspace sibling's JAR also
 * brings that sibling's own classpath along.
 */
class LogFile(entries: Iterable<LogEntry>, malformed: Iterable<String> = emptyList()) {
  /** Records parsed successfully, in file order. */
  val entries: ImmutableList<LogEntry> = ImmutableList.copyOf(entries)

  /** Lines that could not be parsed, in file order. */
  val malformed: ImmutableList<String> = ImmutableList.copyOf(malformed)

  /** Number of parsed records. */
  val size: Int get() = entries.size

  /** Total response bytes across every parsed record. */
  val bytes: Long get() = entries.sumOf { it.bytes }

  /** Records whose status indicates failure. */
  fun failures(): ImmutableList<LogEntry> = ImmutableList.copyOf(entries.filter { it.failed })

  /** Distinct clients seen, sorted. */
  fun clients(): ImmutableList<String> = ImmutableList.copyOf(entries.map { it.client }.distinct().sorted())

  companion object {
    /** A log file with no records. */
    val EMPTY: LogFile = LogFile(emptyList())
  }
}
