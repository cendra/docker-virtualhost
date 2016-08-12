#!/bin/bash
set -e

if [ "$1" = "debug" ]; then
  node-debug --web-host=0.0.0.0 index.js
else
  exec "$@"
fi;
