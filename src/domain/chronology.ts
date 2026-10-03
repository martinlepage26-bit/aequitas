import { z } from "zod";

/** A calendar date must round-trip; JS otherwise normalizes 31 February. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const chronologyInputSchema = z.object({
  occurredOn: z.string().refine(isCalendarDate, "Use a valid calendar date (YYYY-MM-DD)."),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(8000),
  locale: z.enum(["fr-CA", "en-CA"]),
});

/** Preserve the entered date in every viewer's timezone. */
export function formatChronologyDate(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(date);
}
