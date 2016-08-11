#!/bin/bash
set -e

if [ "$1" = "debug" ]; then
  echo "Installing node inspector... please wait"
  #npm install -g node-inspector
  node --debug-brk index.js &
  node-inspector
else
  exec "$@"
fi;
