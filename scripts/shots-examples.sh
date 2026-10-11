#!/bin/bash
# Dev utility: screenshot examples. usage: scripts/shots-examples.sh <outdir> "<id> <steps> <dark>"...
out=$1; shift
for spec in "$@"; do
  read -r id steps dark <<< "$spec"
  node scripts/shot.mjs http://localhost:5173/ "$out" 1440 900 "[{\"dark\":$dark},{\"sleep\":800},{\"click\":\"[data-testid=open-examples]\"},{\"click\":\"[data-testid=example-$id]\"},{\"sleep\":600},{\"click\":\"[data-testid=run]\"},{\"wait\":\"[data-testid=canvas]\"},{\"sleep\":500},{\"click\":\"[data-testid=canvas]\"},{\"press\":\"ArrowRight\",\"times\":$steps},{\"sleep\":500},{\"shot\":\"$id\"}]" 2>&1 | grep -E "pageerror|\[error\]|external" || true
done
