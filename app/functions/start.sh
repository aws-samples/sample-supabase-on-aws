#!/bin/sh
mkdir -p /home/deno/functions/main
# 总是复制最新版本
cp /tmp/main-router.ts /home/deno/functions/main/index.ts
echo "Copied main-router.ts to EFS"
exec /usr/local/bin/edge-runtime "$@"
