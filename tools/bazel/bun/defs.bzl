"""`bun_test`: runs `bun test` over test files against the hermetic Bun of `//tools/bazel/bun`."""

load("@bazel_lib//lib:copy_to_bin.bzl", "COPY_FILE_TO_BIN_TOOLCHAINS", "copy_files_to_bin_actions")

def _bun_test_impl(ctx):
    # Sources are run from the output tree, as rules_js does: Bun resolves a module's imports from its real path, and a
    # runfiles symlink into the source tree would let `../src` resolve to undeclared source files.
    srcs = copy_files_to_bin_actions(ctx, ctx.files.srcs)
    data = copy_files_to_bin_actions(ctx, ctx.files.data)
    bun = ctx.executable._bun
    package = ctx.label.package

    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(
        output = launcher,
        is_executable = True,
        content = """#!/usr/bin/env bash
set -euo pipefail
bun="$PWD/{bun}"
cd "{package}"
# Keep Bun's state inside the test's private temp dir: no transpiler cache in $HOME, no shared install cache.
scratch="${{TEST_TMPDIR:-$(mktemp -d)}}"
export TMPDIR="$scratch" BUN_INSTALL="$scratch/bun" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 DO_NOT_TRACK=1 NO_COLOR=1
# Fake executables the tests write start with `#!/usr/bin/env node`, and the action PATH has no Node: run them on this
# Bun, which acts as Node when invoked under that name.
mkdir -p "$scratch/node-shim"
ln -sf "$bun" "$scratch/node-shim/node"
export PATH="$scratch/node-shim:$PATH"
exec "$bun" test {args} "$@"
""".format(
            bun = bun.short_path,
            package = package or ".",
            args = " ".join(["./" + f.short_path.removeprefix(package + "/") if package else "./" + f.short_path for f in srcs]),
        ),
    )
    runfiles = ctx.runfiles(files = srcs + data + [bun])
    return [DefaultInfo(executable = launcher, runfiles = runfiles)]

bun_test = rule(
    implementation = _bun_test_impl,
    doc = "Runs `bun test` over `srcs` from the package directory; `data` holds the sources and fixtures they read.",
    attrs = {
        "srcs": attr.label_list(allow_files = [".ts", ".tsx", ".js", ".mjs"], mandatory = True, doc = "Test files."),
        "data": attr.label_list(allow_files = True, doc = "Files the tests import or read."),
        "_bun": attr.label(default = "//tools/bazel/bun", executable = True, cfg = "target", allow_single_file = True),
    },
    test = True,
    toolchains = COPY_FILE_TO_BIN_TOOLCHAINS,
)
