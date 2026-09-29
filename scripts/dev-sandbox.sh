#!/bin/sh
# The app on your computer with code rules able to run. The Vercel Sandbox
# is reached with your own Vercel CLI login, read as the server starts and
# never written down: a sandbox token kept in .env.local is one more secret
# to leak, and runs out unseen. `vercel whoami` first renews the login.
#
#   pnpm dev:sandbox        http://localhost:3100
unset NODE_OPTIONS
if vercel whoami >/dev/null 2>&1; then
  for AUTH in "$HOME/Library/Application Support/com.vercel.cli/auth.json" "$HOME/.local/share/com.vercel.cli/auth.json"; do
    [ -f "$AUTH" ] && break
  done
  VERCEL_SANDBOX_TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).token)' "$AUTH")
  VERCEL_TEAM_ID=$(node -e 'console.log(require("./.vercel/project.json").orgId)')
  VERCEL_PROJECT_ID=$(node -e 'console.log(require("./.vercel/project.json").projectId)')
  export VERCEL_SANDBOX_TOKEN VERCEL_TEAM_ID VERCEL_PROJECT_ID
  echo "Code rules run in the Vercel Sandbox, with your Vercel login."
else
  echo "Not signed in to Vercel (vercel login): code rules will not run here."
fi
exec next dev -p "${PORT:-3100}" "$@"
