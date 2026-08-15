#!/usr/bin/env node
// aequitas-implementation-handoff.md guardrail 6 ("Terminology is law") and
// Section 12: fails the build if a forbidden term appears in a user-facing
// message catalog. Reads FORBIDDEN_TERMS from src/i18n/glossary.ts — the
// single source of truth — rather than duplicating the pattern list here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const { FORBIDDEN_TERMS } = await import(path.join(root, "src/i18n/glossary.ts"));

const locales = ["fr-CA", "en-CA"];

function flattenStrings(obj, prefix = "") {
  const entries = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      entries.push([fullKey, value]);
    } else if (value && typeof value === "object") {
      entries.push(...flattenStrings(value, fullKey));
    }
  }
  return entries;
}

let ok = true;

for (const locale of locales) {
  const filePath = path.join(root, "messages", `${locale}.json`);
  const content = JSON.parse(readFileSync(filePath, "utf8"));

  for (const [key, value] of flattenStrings(content)) {
    for (const pattern of FORBIDDEN_TERMS) {
      if (pattern.test(value)) {
        ok = false;
        console.error(`Forbidden term ${pattern} matched ${locale}:${key} = "${value}"`);
      }
    }
  }
}

if (!ok) {
  process.exit(1);
}

console.log(`Forbidden-terms check OK: no matches across ${locales.join(", ")}.`);
