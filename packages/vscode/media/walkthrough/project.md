## Open or create a project

An Elide project is a folder with an `elide.pkl` manifest. A manifest nested inside another project's directory is a separate build and is left alone, unless the enclosing manifest declares it as a workspace member.

**New Project…** lists the templates of the installed CLI (`elide init --templates`), asks the questions that template declares, generates the project and opens it.

Opening a folder that already contains `elide.pkl` is enough — the extension activates on it and syncs.
