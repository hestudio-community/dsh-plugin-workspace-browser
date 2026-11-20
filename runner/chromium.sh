#!/bin/sh
# Do not run Chromium or its children as the privileged runner process.
exec gosu browser env HOME=/home/browser USER=browser LOGNAME=browser /usr/bin/chromium "$@"
