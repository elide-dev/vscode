"""Hermetic Bun binaries, one repository per supported host: `@bun_<os>_<cpu>//:bun`."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

BUN_VERSION = "1.3.14"

# From https://github.com/oven-sh/bun/releases/download/bun-v<BUN_VERSION>/SHASUMS256.txt
_SHA256 = {
    "darwin-aarch64": "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620",
    "darwin-x64": "4183df3374623e5bab315c547cfa0974533cd457d86b73b639f7a87974cd6633",
    "linux-aarch64": "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b",
    "linux-x64": "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f",
}

def _bun_impl(module_ctx):
    for platform, sha256 in _SHA256.items():
        http_archive(
            name = "bun_" + platform.replace("-", "_"),
            url = "https://github.com/oven-sh/bun/releases/download/bun-v{}/bun-{}.zip".format(BUN_VERSION, platform),
            sha256 = sha256,
            strip_prefix = "bun-" + platform,
            build_file_content = """exports_files(["bun"], visibility = ["//visibility:public"])\n""",
        )
    return module_ctx.extension_metadata(
        root_module_direct_deps = ["bun_" + p.replace("-", "_") for p in _SHA256],
        root_module_direct_dev_deps = [],
        reproducible = True,
    )

bun = module_extension(implementation = _bun_impl)
