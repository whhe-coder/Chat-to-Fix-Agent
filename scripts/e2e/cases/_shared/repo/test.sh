#!/bin/sh
# The test command of this repository: exit code 0 when every test file passes.
cd "$(dirname "$0")" || exit 2
for f in test/*.test.js; do
  node "$f" || exit 1
done
