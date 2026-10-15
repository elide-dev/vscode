package logstat.report

import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import logstat.model.LogEntry
import logstat.model.LogFile

class ReportsTest {
  private fun entry(path: String, status: Int = 200, client: String = "10.0.0.1") =
    LogEntry(client, "2026-02-11T00:00:00Z", "GET", path, status, 100)

  private val file = LogFile(
    listOf(
      entry("/a"),
      entry("/a", client = "10.0.0.2"),
      entry("/b", status = 500),
      entry("/c", status = 404, client = "10.0.0.2"),
    )
  )

  @Test fun `ranking is by descending count then key`() {
    assertEquals(listOf("/a" to 2, "/b" to 1, "/c" to 1), Reports.rank(file, Dimension.PATH))
  }

  @Test fun `top honors the limit`() {
    val rendered = Reports.top(file, Dimension.PATH, limit = 1)
    assertContains(rendered, "/a")
    assertEquals(3, rendered.trim().lines().size) // header, rule, one row
  }

  @Test fun `a non-positive limit is rejected`() {
    assertFailsWith<IllegalArgumentException> { Reports.top(file, Dimension.PATH, limit = 0) }
  }

  @Test fun `summary reports the failure rate and outcome breakdown`() {
    val rendered = Reports.summary(file)
    assertContains(rendered, "2 (50.0%)")
    assertContains(rendered, "4xx")
    assertContains(rendered, "5xx")
  }

  @Test fun `failures can be filtered by minimum status`() {
    assertContains(Reports.failures(file, minStatus = 500), "/b")
    assertEquals("No requests with status >= 600.\n", Reports.failures(file, minStatus = 600))
  }

  @Test fun `dimensions are looked up case-insensitively`() {
    assertEquals(Dimension.CLIENT, Dimension.of("Client"))
    assertEquals(null, Dimension.of("nope"))
  }

  @Test fun `an empty file reports nothing rather than dividing by zero`() {
    assertEquals("No requests parsed.\n", Reports.summary(LogFile.EMPTY))
    assertEquals("No requests parsed.\n", Reports.top(LogFile.EMPTY, Dimension.PATH, limit = 5))
  }
}
