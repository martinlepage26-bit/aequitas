#!/usr/bin/env node
// aequitas-implementation-handoff.md Section 12: "A CI check fails the build
// if any key exists in one locale but not the other."

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const messagesDir = path.join(here, "..", "messages");
const locales = ["fr-CA", "en-CA"];

function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...flattenKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

const keySets = new Map();
for (const locale of locales) {
  const filePath = path.join(messagesDir, `${locale}.json`);
  const content = JSON.parse(readFileSync(filePath, "utf8"));
  keySets.set(locale, new Set(flattenKeys(content)));
}

const [firstLocale, ...restLocales] = locales;
const referenceKeys = keySets.get(firstLocale);
let ok = true;

for (const locale of restLocales) {
  const keys = keySets.get(locale);
  const missingFromLocale = [...referenceKeys].filter((k) => !keys.has(k));
  const missingFromReference = [...keys].filter((k) => !referenceKeys.has(k));

  if (missingFromLocale.length > 0) {
    ok = false;
    console.error(`Keys in ${firstLocale} missing from ${locale}:\n  ${missingFromLocale.join("\n  ")}`);
  }
  if (missingFromReference.length > 0) {
    ok = false;
    console.error(`Keys in ${locale} missing from ${firstLocale}:\n  ${missingFromReference.join("\n  ")}`);
  }
}

if (!ok) {
  process.exit(1);
}

console.log(`i18n parity OK: ${referenceKeys.size} keys match across ${locales.join(", ")}.`);
