import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Isolate VS Code module mocks from Bun's shared module registry, as the other lifecycle tests do.
test("task progress isolates concurrent runs, reruns, cancellation, and unrelated task processes", () => {
  const source = new URL("../src/", import.meta.url).pathname;
  const result = spawnSync(process.execPath, ["--eval", `
    import assert from "node:assert/strict";
    import { once, EventEmitter } from "node:events";
    import { connect } from "node:net";
    import { mock } from "bun:test";
    import { TimelineNode } from "@elide/ide-core";
    const source = ${JSON.stringify(source)};
    const events = new EventEmitter();
    const starts = [], ends = [], roots = [], cancels = [];
    class ProcessExecution { constructor(process, args, options) { Object.assign(this, {process,args,options}); } }
    mock.module("vscode", () => ({
      ProcessExecution,
      tasks: {
        onDidStartTaskProcess: fn => { starts.push(fn); return {dispose() {}}; },
        onDidEndTaskProcess: fn => { ends.push(fn); return {dispose() {}}; },
      },
    }));
    mock.module(source + "taskProgressView.js", () => ({
      TaskProgressView: class {
        start(label, options) {
          const root = TimelineNode.root(label, {onChange: () => events.emit("changed")});
          roots.push(root); cancels.push(options.cancel); events.emit("started"); return root;
        }
        async reveal() {}
        dispose() {}
      },
    }));
    // Static import would load vscode before its isolated runtime mocks have been installed.
    const { ElideTaskProgress } = await import(source + "taskProgress.ts");
    const progress = new ElideTaskProgress({}, {}, source + "taskRunner.ts");
    const failures = [];
    const process = await progress.execution("build app", {bin:"/elide",cwd:"/project",argv:["build","app"]}, failure => failures.push(failure));
    const port = Number(process.args[1]), secret = process.args[2];
    const unrelated = {task:{execution:new ProcessExecution("/other",[],{})},terminate(){ throw new Error("Unrelated task was terminated"); }};
    starts.forEach(fn => fn({processId:90,execution:unrelated}));
    const bad = connect(port,"127.0.0.1");
    await once(bad,"connect"); const rejected = once(bad,"close"); bad.write("null\\n"); await rejected;
    const client = async pid => {
      const socket = connect(port,"127.0.0.1"); await once(socket,"connect");
      const ready = once(events,"started");
      socket.write(JSON.stringify({type:"start",secret,label:"build app",argv:["build","app"],cwd:"/project",pid})+"\\n");
      await ready; return socket;
    };
    const until = async predicate => { while(!predicate()) await once(events,"changed"); };
    let stoppedA=0, stoppedB=0;
    const a = await client(101), b = await client(102);
    const taskA = {task:{execution:process},terminate(){stoppedA++;}};
    const taskB = {task:{execution:process},terminate(){stoppedB++;}};
    // A click can arrive before VS Code delivers its process-start event.
    cancels[0]();
    starts.forEach(fn => fn({processId:102,execution:taskB}));
    starts.forEach(fn => fn({processId:101,execution:taskA}));
    assert.equal(stoppedA,1); assert.equal(stoppedB,0);
    const cancelled = until(() => roots[0].state === "cancelled"); a.end(); await cancelled;
    ends.forEach(fn => fn({execution:taskA}));
    assert.equal(roots[1].state,"running");
    const finished = until(() => roots[1].state === "failed");
    b.end([
      {type:"record",record:{type:"task-started",task:"compile",message:"Compile app",time:0}},
      {type:"record",record:{type:"message",level:"error",text:"Compiler rejected app",time:1}},
      {type:"record",record:{type:"task-finished",task:"compile",message:"Compile app",outcome:"failure",durationMs:15,time:2}},
      {type:"end",exitCode:7,durationMs:20,aborted:false},
    ].map(value=>JSON.stringify(value)+"\\n").join(""));
    await finished;
    assert.deepEqual(failures,[{exitCode:7,failure:{errors:1,error:"Compiler rejected app"}}]);
    assert.equal(roots[1].children[0].children[0].state,"failed");
    ends.forEach(fn => fn({execution:taskB}));
    const rerun = await client(103);
    const done = until(() => roots[2].state === "succeeded");
    rerun.end(JSON.stringify({type:"end",exitCode:0,durationMs:2,aborted:false})+"\\n"); await done;
    assert.notEqual(roots[2],roots[1]);
    assert.equal(roots[0].state,"cancelled"); assert.equal(roots[1].state,"failed");
    progress.dispose();
    assert.equal(stoppedB,0); assert.equal(stoppedA,1);
  `], { encoding: "utf8", timeout: 15_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
