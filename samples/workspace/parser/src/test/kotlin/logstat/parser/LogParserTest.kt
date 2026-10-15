package logstat.parser

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import logstat.model.Outcome

class LogParserTest {
  @Test fun `parses a well-formed line`() {
    val entry = LogParser.parseLine("""10.0.0.7 [2026-02-11T08:15:04Z] "GET /index.html" 200 5120""")
    assertEquals("10.0.0.7", entry?.client)
    assertEquals("GET", entry?.method)
    assertEquals("/index.html", entry?.path)
    assertEquals(200, entry?.status)
    assertEquals(5120L, entry?.bytes)
    assertEquals(Outcome.SUCCESS, entry?.outcome)
  }

  @Test fun `rejects a line with a missing field`() {
    assertNull(LogParser.parseLine("""10.0.0.7 [2026-02-11T08:15:04Z] "GET /index.html" 200"""))
  }

  @Test fun `keeps unparseable lines instead of failing`() {
    val file = LogParser.parseText(
      """
      # comment
      10.0.0.7 [t] "GET /a" 200 10

      not a log line at all
      10.0.0.8 [t] "POST /b" 503 0
      """.trimIndent()
    )
    assertEquals(2, file.size)
    assertEquals(listOf("not a log line at all"), file.malformed)
    assertEquals(10L, file.bytes)
    assertEquals(listOf("10.0.0.7", "10.0.0.8"), file.clients())
    assertEquals(1, file.failures().size)
  }
}
