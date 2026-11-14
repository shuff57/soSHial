// A structured personal-details check: patterns only, no names. It catches Social Security numbers,
// emails, phone numbers, long card-like numbers, street addresses and bank account numbers. A
// message that matches is refused with a plain reason (core.ts piiRefusal). Pass your own check to
// createSoshial({ findPII }) to replace it.

interface PiiPattern {
  label: string;
  re: RegExp;
}

const PII_PATTERNS: PiiPattern[] = [
  { label: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { label: 'email', re: /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i },
  { label: 'phone', re: /\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/ },
  { label: 'credit card', re: /\b(?:\d[ -]*?){13,16}\b/ },
  {
    label: 'address',
    re: /\b\d{1,5}\s+\w+(\s\w+){0,3}\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|blvd|court|ct)\b/i,
  },
  {
    // A bare digit run has no shape of its own, so this needs the keyword right next to it.
    label: 'bank account number',
    re: /\b(?:bank\s+account|checking\s+account|savings\s+account|routing\s+number|account\s+number)\b[^\d]{0,15}\d{6,17}\b/i,
  },
];

/** The label of the first kind of personal detail found, or null. */
export function findPII(text: string): string | null {
  for (const p of PII_PATTERNS) {
    if (p.re.test(text)) return p.label;
  }
  return null;
}
