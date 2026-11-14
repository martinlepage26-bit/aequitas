import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";

const source = new URL("./site/", import.meta.url);
const output = new URL("./dist/", import.meta.url);
if (!existsSync(source)) throw new Error("Missing static demo source directory");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(source, output, { recursive: true });
for (const path of ["en-CA/index.html", "fr-CA/index.html", "assets/site.js", "assets/site.css", "assets/fonts/roboto-flex-latin.woff2", "assets/fonts/roboto-flex-latin-ext.woff2", "assets/fonts/OFL.txt", "content/en-CA.json", "content/fr-CA.json", "_headers", "_redirects"]) {
  if (!existsSync(new URL(path, output))) throw new Error(`Missing deployment asset: ${path}`);
}
console.log("Static Aequitas demo built for Cloudflare Pages (no app API or database included).");
