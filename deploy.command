#!/bin/bash
cd "$(dirname "$0")"
echo "Torque Index - deploying to Cloudflare"
npx --yes wrangler@latest login
npx --yes wrangler@latest deploy
echo; echo "Done! Your site address is shown above (ends in .workers.dev)."
read -p "Press Enter to close"
