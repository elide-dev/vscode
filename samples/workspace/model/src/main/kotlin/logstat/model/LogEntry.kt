package logstat.model

/** One request recorded in an access log. */
data class LogEntry(
  val client: String,
  val timestamp: String,
  val method: String,
  val path: String,
  val status: Int,
  val bytes: Long,
) {
  /** Outcome class this entry's status code falls into. */
  val outcome: Outcome get() = Outcome.of(status)

  /** Whether the request failed, from the client's point of view. */
  val failed: Boolean get() = status >= 400

  override fun toString(): String = "$client $method $path -> $status (${bytes}b)"
}

/** Coarse classification of a response status code. */
enum class Outcome(val label: String) {
  SUCCESS("2xx"),
  REDIRECT("3xx"),
  CLIENT_ERROR("4xx"),
  SERVER_ERROR("5xx"),
  UNKNOWN("???");

  companion object {
    /** Outcome for [status]; [UNKNOWN] for anything outside the 2xx-5xx range. */
    fun of(status: Int): Outcome = when (status / 100) {
      2 -> SUCCESS
      3 -> REDIRECT
      4 -> CLIENT_ERROR
      5 -> SERVER_ERROR
      else -> UNKNOWN
    }
  }
}
