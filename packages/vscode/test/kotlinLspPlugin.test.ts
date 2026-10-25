import { expect, test } from "bun:test";
import { withoutKotlinLspPlugin } from "../src/kotlinLspPlugin.js";

test("earlier releases' plugin entries leave intellij.additionalJvmArgs, from any profile; the user's own stay", () => {
  const cacheRoot = "/Users/u/Library/Application Support/Code/User/globalStorage/elide.elide";
  const ours = `${cacheRoot}/kotlin-lsp-plugin/f23aeb285ee8eb4506bddb8c/elide`;
  const otherProfile = "/Users/u/Library/Application Support/Code/User/profiles/7b1/globalStorage/elide.elide/kotlin-lsp-plugin/0a1/elide";
  expect(withoutKotlinLspPlugin([`-Dplugin.path=${ours}`], cacheRoot)).toEqual([]);
  expect(withoutKotlinLspPlugin(["-Xmx4g", `-Dplugin.path=/opt/mine:${otherProfile}:${ours}`], cacheRoot)).toEqual(["-Xmx4g", "-Dplugin.path=/opt/mine"]);
  expect(withoutKotlinLspPlugin(["-Xmx4g", "-Dplugin.path=/opt/mine"], cacheRoot)).toBeUndefined();
  expect(withoutKotlinLspPlugin([], cacheRoot)).toBeUndefined();
});
