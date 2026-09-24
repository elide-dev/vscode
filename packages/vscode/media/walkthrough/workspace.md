## Grow into a workspace

A manifest that lists `workspace.members` is the root of an Elide workspace: every member is a project with its own
`elide.pkl`, and Elide builds, installs and tests them as one graph.

```pkl
workspace {
  members {
    "model"
    "cli"
  }
}
```

A member consumes a sibling's artifact with `module.project("model")` in its Maven dependencies. The extension turns
that into a dependency on the sibling's sources, so completion and Go to Definition cross project boundaries without
building anything first.

**Add Workspace Member…** creates a member from a template inside the root's directory and declares it for you. Each
member then appears under the root in the Elide view, in the Testing view, and in the task and debug lists.

Open the workspace **root** rather than a member's own directory: only the root resolves the siblings a member
depends on.
