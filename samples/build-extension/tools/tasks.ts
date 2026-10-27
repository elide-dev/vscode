export default ({ task }: ElideBuild) => {
  task("greet", { description: "Greet from an Elide build extension" }, (ctx) => {
    ctx.log(`${ctx.config.greeting ?? "Hello"} from ${ctx.project.name}`);
  });
};
