#!/bin/bash
message="$1"
yarn format && yarn build && yarn package
git add ./src
git add ./dist
git commit -m "$message => build: $(date +'%y.%m.%d-%H%M')"
git push origin main
