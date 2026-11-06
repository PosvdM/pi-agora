#!/bin/sh
# Prepares the fixture, then execs into pi's TUI so pi is the foreground job of this terminal,
# the same as a user typing `pi`. Nothing here traps or ignores SIGHUP.
dir=$(cd "$(dirname "$0")" && pwd) || exit 1
launch=$("${NODE:-node}" "$dir/prepare.mjs") || exit $?
exec /bin/sh "$launch"
