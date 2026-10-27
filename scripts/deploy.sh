#!/bin/sh
# Builds the production site and publishes it to the gh-pages branch, which GitHub Pages serves.
set -eu
cd "$(dirname "$0")/.."
[ -f .env.production.local ] || { echo "Missing .env.production.local (see .env.example)"; exit 1; }
npx vite build --mode production
if grep -rqE 'sb_secret_[A-Za-z0-9]|service_role"' dist; then echo "Refusing to deploy: a secret key is in the build."; exit 1; fi
touch dist/.nojekyll
cd dist
rm -rf .git
git init -q -b gh-pages
git add -A
git -c user.name="$(git -C .. config user.name)" -c user.email="$(git -C .. config user.email)" commit -q -m "Deploy $(git -C .. rev-parse --short HEAD)"
git push -q --force "$(git -C .. remote get-url origin)" gh-pages
rm -rf .git
echo "Deployed. The site updates within a minute or two."
