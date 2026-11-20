#!/bin/sh
set -eu
if [ -n "$DSH_BROWSER_GROUPS" ]; then
  groups="--groups=$DSH_BROWSER_GROUPS"
else
  groups=--clear-groups
fi
exec setpriv "--reuid=$DSH_BROWSER_UID" "--regid=$DSH_BROWSER_GID" "$groups" -- /usr/bin/chromium "$@"
