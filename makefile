bundle:
	deno bundle --no-check ui.ts | esbuild --target=es2020,chrome89,firefox88,safari13 > public/ui.bundle.js
