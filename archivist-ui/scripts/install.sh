#!/usr/bin/env bash

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR/.." || exit 1

npm run dist
rm -rf /Applications/Archivist.app
mv ./dist/mac/Archivist.app /Applications
rm -rf ./dist
