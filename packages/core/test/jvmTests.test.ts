import { describe, expect, test } from "bun:test";
import { jvmTestNamePattern, parseTapLabel, scanJvmTestSource } from "../src/index.js";

const KOTLIN = `package sample

import kotlin.test.Test
import kotlin.test.assertEquals
import org.junit.jupiter.api.Nested
import org.junit.jupiter.params.ParameterizedTest

class MainTest {
    @Test
    fun testGreeting() {
        assertEquals("Hello Elide! // not a comment { ", greeting())
    }

    @Test
    fun \`handles # in names\`() = Unit

    @ParameterizedTest
    @ValueSource(ints = [1, 2])
    fun parameterized(value: Int) = Unit

    fun helper() = Unit

    @Nested
    inner class Inner {
        @Test
        fun works() {
        }
    }
}

/* @Test
fun commentedOut() {} */

class NotATest {
    fun run() {}
}
`;

const JAVA = `package sample;

import org.junit.jupiter.api.Test;

public class CalculatorTest {
    @org.junit.jupiter.api.Test
    public void adds() {
        assertEquals(2, 1 + 1);
    }

    private int helper() {
        return 1;
    }
}
`;

describe("scanJvmTestSource", () => {
  test("finds Kotlin test methods, including backticked and parameterized ones", () => {
    const scanned = scanJvmTestSource(KOTLIN, "kotlin");
    expect(scanned.packageName).toBe("sample");
    expect(scanned.classes.map((c) => c.binaryName)).toEqual(["sample.MainTest", "sample.MainTest$Inner"]);

    const [main, inner] = scanned.classes;
    expect(main?.simpleName).toBe("MainTest");
    expect(main?.line).toBe(7);
    expect(main?.methods).toEqual([
      { name: "testGreeting", line: 9 },
      { name: "handles # in names", line: 14 },
      { name: "parameterized", line: 18 },
    ]);
    expect(inner?.methods).toEqual([{ name: "works", line: 25 }]);
  });

  test("classes without tests are dropped, commented-out code is not scanned", () => {
    const names = scanJvmTestSource(KOTLIN, "kotlin").classes.map((c) => c.simpleName);
    expect(names).not.toContain("NotATest");
    expect(scanJvmTestSource(KOTLIN, "kotlin").classes.flatMap((c) => c.methods.map((m) => m.name))).not.toContain(
      "commentedOut",
    );
  });

  test("finds Java test methods annotated with a qualified name", () => {
    const scanned = scanJvmTestSource(JAVA, "java");
    expect(scanned.classes).toEqual([
      { binaryName: "sample.CalculatorTest", simpleName: "CalculatorTest", line: 4, methods: [{ name: "adds", line: 6 }] },
    ]);
  });

  test("a file without a package still yields binary names", () => {
    const scanned = scanJvmTestSource("class T {\n  @Test\n  fun a() {}\n}\n", "kotlin");
    expect(scanned.packageName).toBe("");
    expect(scanned.classes[0]?.binaryName).toBe("T");
  });
});

describe("jvmTestNamePattern", () => {
  test("anchors a method target and opens a class target to its nested members", () => {
    expect(jvmTestNamePattern([{ binaryName: "sample.MainTest", method: "testGreeting" }])).toBe(
      "^sample\\.MainTest#testGreeting$",
    );
    expect(jvmTestNamePattern([{ binaryName: "sample.MainTest" }])).toBe("^sample\\.MainTest[#$]");
    expect(jvmTestNamePattern([{ binaryName: "sample.Outer$Inner" }])).toBe("^sample\\.Outer\\$Inner[#$]");
  });

  test("several targets alternate, and nothing selected means no filter", () => {
    expect(jvmTestNamePattern([{ binaryName: "a.B", method: "x" }, { binaryName: "a.C" }])).toBe("^a\\.B#x$|^a\\.C[#$]");
    expect(jvmTestNamePattern([])).toBeUndefined();
  });

  test("the JVM engine's binary name for a scanned test matches the generated pattern", () => {
    const [cls] = scanJvmTestSource(KOTLIN, "kotlin").classes;
    const pattern = jvmTestNamePattern([{ binaryName: cls?.binaryName ?? "", method: "testGreeting" }]) ?? "";
    expect(new RegExp(pattern).test("sample.MainTest#testGreeting")).toBe(true);
    expect(new RegExp(pattern).test("sample.MainTest#testGreetingLoudly")).toBe(false);
  });
});

describe("parseTapLabel", () => {
  test("splits the container chain from the test name and drops the parameter list", () => {
    expect(parseTapLabel("Outer > Inner > works()")).toEqual({ containers: ["Outer", "Inner"], name: "works" });
    expect(parseTapLabel("sample.MainTest > testGreeting()")).toEqual({
      containers: ["sample.MainTest"],
      name: "testGreeting",
    });
    expect(parseTapLabel("standalone")).toEqual({ containers: [], name: "standalone" });
  });

  test("an engine container is not part of the class chain", () => {
    expect(parseTapLabel("JUnit Jupiter > MainTest > works()")).toEqual({ containers: ["MainTest"], name: "works" });
  });
});
