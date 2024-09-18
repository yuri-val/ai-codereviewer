#!/bin/bash
message="$1"
yarn format && yarn build && yarn package
git add ./src
git add ./dist
git commit -m "build: $(date +'%y.%m.%d-%H%M') => $message"
git push origin main
