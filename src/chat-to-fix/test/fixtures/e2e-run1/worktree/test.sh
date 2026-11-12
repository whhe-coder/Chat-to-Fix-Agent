#!/bin/sh
# The test command of this repository: exit code 0 when everything passes.
cd "$(dirname "$0")" || exit 2
exec node test.js
