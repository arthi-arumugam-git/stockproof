#!/usr/bin/env bash
# Bump the cache-busting version on every asset so returning visitors never run a stale mix of
# old and new modules. Run this before pushing a change to site/.
#   ./release.sh 0.1.1
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: ./release.sh <version>"; exit 2; }
V="$1"
sed -i -E "s/\.js\?v=[0-9.]+/.js?v=$V/g; s/\.css\?v=[0-9.]+/.css?v=$V/g" site/index.html site/js/*.js
node -e "const p=require('./package.json');p.version='$V';require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
npm test
echo "bumped to $V"
