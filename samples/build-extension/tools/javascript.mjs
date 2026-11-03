// @ts-check
/** @param {ElideBuild} build */
export default function ({ task }) {
  task("greet-js", { description: "Greet from JavaScript" }, (ctx) => {
    ctx.log("JavaScript extension", ctx.project.name);
  });
}
