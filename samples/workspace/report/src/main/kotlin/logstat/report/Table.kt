package logstat.report

import org.apache.commons.lang3.StringUtils

/** Fixed-width text table: columns are sized to their widest cell. */
class Table(private vararg val headers: String) {
  private val rows = mutableListOf<List<String>>()

  /** Append a row; cells are rendered with [toString], `null` as an empty cell. */
  fun row(vararg cells: Any?): Table = apply {
    require(cells.size == headers.size) { "expected ${headers.size} cells, got ${cells.size}" }
    rows.add(cells.map { it?.toString() ?: "" })
  }

  /** Whether any row has been added. */
  fun isEmpty(): Boolean = rows.isEmpty()

  /** Render the table, header row included. */
  fun render(): String {
    val widths = headers.indices.map { column ->
      (rows.map { it[column] } + headers[column]).maxOf { it.length }
    }
    val out = StringBuilder()
    fun line(cells: List<String>) {
      out.append(cells.mapIndexed { i, cell -> StringUtils.rightPad(cell, widths[i]) }.joinToString("  ").trimEnd())
      out.append('\n')
    }
    line(headers.toList())
    line(widths.map { StringUtils.repeat('-', it) })
    rows.forEach(::line)
    return out.toString()
  }
}
