#!/usr/bin/env bash
# Relaunch the codbash desktop app FROM SOURCE with live frontend reload.
#
# Use this (not the installed DMG) to see uncommitted changes:
#   • The window shows an amber "DEV" badge next to the version.
#   • Frontend edits (src/frontend/**) → just press Cmd+R in the window.
#   • Backend edits (src/*.js, bin/**) → re-run this script.
#
# It kills any prior dev instances first so you never end up staring at a stale
# window on the wrong port.
set -e
pkill -f "codbash/desktop" 2>/dev/null || true
pkill -f "bin/cli.js run" 2>/dev/null || true
sleep 1
cd "$(dirname "$0")"
NODE_ENV=development exec npm start
