#!/bin/sh
case "$1" in
  *Username*) printf '%s' oauth2 ;;
  *) printf '%s' "$GIT_HISTORY_TOKEN" ;;
esac
