package sample

/** Prints the [greeting] of a few words. */
fun main() {
    val words = listOf("Hello", "Elide!")
    println(greeting(words))
}

fun greeting(words: List<String>): String = words.joinToString(" ")
