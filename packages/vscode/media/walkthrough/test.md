## Run tests

JUnit tests in the project's test source sets appear in the Testing view, with gutter icons next to each class and method.

Running an item invokes `elide test --reporter=tap`, narrowed to the selection, and reports each result as it settles; a failure carries the assertion message and jumps to the offending line.

The Debug profile runs the same command under a JDWP agent, so breakpoints in test code are hit.
