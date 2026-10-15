package logstat.cli

import kotlin.system.exitProcess

/** Entrypoint declared by `cli/elide.pkl` as `jvm.main`. */
fun main(args: Array<String>) {
  val out = StringBuilder()
  val err = StringBuilder()
  val code = Cli.run(args.toList(), out, err)
  print(out)
  if (err.isNotEmpty()) System.err.print(err)
  if (code != 0) exitProcess(code)
}
