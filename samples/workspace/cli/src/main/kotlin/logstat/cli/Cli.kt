package logstat.cli

/** Command dispatch: name lookup, usage text, and exit codes. */
object Cli {
  /** Exit code for a command that could not be understood. */
  const val EXIT_USAGE: Int = 2

  private val COMMANDS: List<Command> = listOf(SummaryCommand, TopCommand, FailuresCommand, HelpCommand)
  private val BY_NAME: Map<String, Command> = COMMANDS.associateBy { it.name }

  /** Command called [name], or `null`. */
  fun command(name: String): Command? = BY_NAME[name]

  /** Usage text listing every command. */
  fun usage(): String = buildString {
    append("logstat -- access-log reports\n\nUsage: logstat <command> [args]\n\nCommands:\n")
    val width = COMMANDS.maxOf { it.usage.length }
    for (command in COMMANDS) {
      append("  ").append(command.usage.padEnd(width)).append("  ").append(command.summary).append('\n')
    }
  }

  /**
   * Run [argv], writing output to [out] and diagnostics to [err].
   *
   * @return process exit code: 0 on success, [EXIT_USAGE] for a usage error.
   */
  fun run(argv: List<String>, out: Appendable, err: Appendable): Int {
    val args = Arguments.parse(argv)
    if (args.flag("help") || argv.isEmpty()) {
      out.append(usage())
      return 0
    }
    val name = args.positional(0)!!
    val command = command(name)
    if (command == null) {
      err.append("Unknown command '").append(name).append("'\n\n").append(usage())
      return EXIT_USAGE
    }
    // The command name itself is consumed here, so each command sees its own arguments at 0.
    return try {
      command.run(Arguments.parse(argv.drop(argv.indexOf(name) + 1)), out)
      0
    } catch (error: UsageError) {
      err.append("error: ").append(error.message).append('\n')
      EXIT_USAGE
    }
  }
}
