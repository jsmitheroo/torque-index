# Torque Index: Cloudflare deployment

This folder holds the whole site plus the small server that runs online battles
(room codes). It runs on Cloudflare's free plan.

## What's inside
- `public/`: the website (index.html, car photo sprites, icons)
- `worker.js`: serves the site, runs online battle rooms, and handles accounts (sign up, log in, progress sync). Passwords are stored hashed (PBKDF2).
- `wrangler.jsonc`: Cloudflare settings
- `deploy.bat` (Windows) / `deploy.command` (Mac): one-click deploy

## Deploy (first time)
1. Install **Node.js LTS** from https://nodejs.org
2. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up
3. Unzip BOTH zip parts into the same folder, so that `public/sprites` has all its files.
4. Double-click `deploy.bat` (Windows) or `deploy.command` (Mac).
   Alternatively, open a terminal in this folder and run:
   ```
   npx wrangler login
   npx wrangler deploy
   ```
5. Wrangler prints your live address, e.g. `https://torque-index.<you>.workers.dev`

To update later, replace the files and run deploy again.

## Custom domain (optional)
In the Cloudflare dashboard go to Workers & Pages, then torque-index, then Settings, then Domains & Routes, and add your domain.

## Test locally (optional)
`npm install`, then `npm run dev`, then open http://localhost:8787 in two browser windows.

## Notes
- Online battles need this Worker. A plain static host (drag-and-drop Pages or Netlify) serves the site but shows "Online battles need the hosted site".
- Rooms delete themselves after 3 hours with nobody connected.
- The free plan's Durable Objects limits are far above what casual play uses.

© 2026 James Smith. All rights reserved.
