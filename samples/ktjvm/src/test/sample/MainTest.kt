package sample

import kotlin.test.Test
import kotlin.test.assertEquals

class MainTest {
    @Test
    fun testGreeting() {
        assertEquals("Hello Elide!", greeting(listOf("Hello", "Elide!")))
    }
}
