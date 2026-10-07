#!/bin/zsh
# Start the real engagement sim server (OEL + wargame) for the table's ENGAGEMENT mode on http://localhost:8791.
# First time only: the venv is created by the install steps in gengalactic-demos/apps/orbital-sim (see DESIGN.md §8b).
cd "${0:A:h}/.."
exec ../gengalactic-demos/apps/orbital-sim/orbital-engagement-lab-main/.venv/bin/python tools/engage_server.py "$@"
