#!/bin/bash
# Double-click me on a Mac to start Trains Maxxing.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed yet."
  echo "Get the LTS version from https://nodejs.org, install it, then double-click this file again."
  read -r -n 1 -p "Press any key to close."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "First run: installing (needs internet once)..."
  npm install || { read -r -n 1 -p "Install failed. Press any key to close."; exit 1; }
fi
node server/index.js --open
read -r -n 1 -p "Trains Maxxing has stopped. Press any key to close."
