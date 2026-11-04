#!/bin/sh
# Builds the native audio helper (mic capture, playback, macOS voice processing).
set -eu
DIR="$(cd "$(dirname "$0")/../native/vw-audio" && pwd)"
xcrun swiftc -O -swift-version 5 "$DIR/main.swift" -o "$DIR/vw-audio"
echo "built $DIR/vw-audio"
