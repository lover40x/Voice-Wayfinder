#!/bin/sh
# Starts the voice bridge MCP server.
#
# The OpenAI key is never stored on disk: the bws access token is read from the
# macOS Keychain and `bws run` injects OPENAI_REALTIME_API_KEY into the bridge
# process alone. Without a token the bridge still starts, so its tools can tell
# Claude (and you) what is missing instead of the server silently failing.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYCHAIN_SERVICE="${VOICE_WAYFINDER_KEYCHAIN_SERVICE:-voice-wayfinder-bws}"

# The desktop app starts MCP servers with a minimal PATH.
PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
export PATH

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "voice-wayfinder: node not found on PATH" >&2
  exit 1
fi

if [ ! -x "$ROOT/native/vw-audio/vw-audio" ]; then
  sh "$ROOT/scripts/build-audio.sh" >&2 || echo "voice-wayfinder: audio helper build failed" >&2
fi

BRIDGE="$ROOT/server/bridge.mjs"

# A key already in the environment wins (CI, or a one-off test).
if [ -n "${OPENAI_REALTIME_API_KEY:-}" ]; then
  exec "$NODE" "$BRIDGE"
fi

TOKEN="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)"
if [ -z "$TOKEN" ] || ! command -v bws >/dev/null 2>&1; then
  VOICE_WAYFINDER_SECRET_PROBLEM="no bws access token in Keychain service '$KEYCHAIN_SERVICE' (or bws missing)"
  export VOICE_WAYFINDER_SECRET_PROBLEM
  exec "$NODE" "$BRIDGE"
fi

BWS_ACCESS_TOKEN="$TOKEN"
export BWS_ACCESS_TOKEN
unset TOKEN

# bws run joins its arguments into one `sh -c` string, so quote the paths
# ourselves (the plugin folder may contain spaces).
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
CMD="exec $(quote "$NODE") $(quote "$BRIDGE")"
if [ -n "${VOICE_WAYFINDER_BWS_PROJECT_ID:-}" ]; then
  exec bws run --project-id "$VOICE_WAYFINDER_BWS_PROJECT_ID" -- "$CMD"
fi
exec bws run -- "$CMD"
