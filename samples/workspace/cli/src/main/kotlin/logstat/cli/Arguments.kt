package logstat.cli

/** Raised when a command line cannot be understood; the message is shown to the user verbatim. */
class UsageError(message: String) : RuntimeException(message)

/**
 * Positional arguments and `--name value` / `--name=value` options, split apart.
 *
 * Deliberately tiny: the point of this sample is the workspace layout, not argument parsing.
 */
class Arguments private constructor(
  private val positional: List<String>,
  private val options: Map<String, String>,
) {
  /** Positional argument [index], or [fallback] when it was not given. */
  fun positional(index: Int, fallback: String? = null): String? = positional.getOrNull(index) ?: fallback

  /** Option [name] as a string, or [fallback]. */
  fun string(name: String, fallback: String? = null): String? = options[name] ?: fallback

  /** Option [name] as a positive integer, or [fallback]. */
  fun int(name: String, fallback: Int): Int {
    val raw = options[name] ?: return fallback
    return raw.toIntOrNull() ?: throw UsageError("--$name expects a number, got '$raw'")
  }

  /** Whether flag [name] was given. */
  fun flag(name: String): Boolean = options[name] == FLAG

  companion object {
    private const val FLAG = "\u0000flag"
    private val VALUELESS = setOf("help", "no-color")

    /** Split [args]; an option with no value is a flag unless it is followed by a value. */
    fun parse(args: List<String>): Arguments {
      val positional = mutableListOf<String>()
      val options = mutableMapOf<String, String>()
      var index = 0
      while (index < args.size) {
        val arg = args[index++]
        when {
          !arg.startsWith("--") -> positional.add(arg)
          // Everything after a bare `--` is positional, even if it looks like an option.
          arg == "--" -> {
            positional.addAll(args.subList(index, args.size))
            index = args.size
          }
          "=" in arg -> {
            val (name, value) = arg.removePrefix("--").split("=", limit = 2)
            if (name.isEmpty()) throw UsageError("Malformed option '$arg'")
            options[name] = value
          }
          else -> {
            val name = arg.removePrefix("--")
            val next = args.getOrNull(index)
            if (name in VALUELESS || next == null || next.startsWith("--")) {
              options[name] = FLAG
            } else {
              options[name] = next
              index++
            }
          }
        }
      }
      return Arguments(positional, options)
    }
  }
}
