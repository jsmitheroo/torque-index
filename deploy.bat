@echo off
cd /d "%~dp0"
echo Torque Index - deploying to Cloudflare
echo A browser window will open so you can log in to Cloudflare (free account).
call npx --yes wrangler@latest login
call npx --yes wrangler@latest deploy
echo.
echo Done! Your site address is shown above (ends in .workers.dev).
pause
