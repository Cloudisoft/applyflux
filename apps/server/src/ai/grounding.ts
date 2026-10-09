/**
 * Post-generation fabrication guard. Generated text may only contain numbers
 * (years, percentages, counts, money) and credential acronyms that appear in
 * the candidate's facts. Anything else is flagged so the answer is treated as
 * uncertain and shown to the person instead of being submitted.
 */

const CREDENTIALS = /\b(phd|ph\.d|mba|msc|m\.sc|bsc|b\.sc|ba|ma|cpa|cfa|pmp|cissp|aws certified|ccna|frm|acca|llm|jd|md)\b/gi;

export function groundingIssues(generated: string, facts: string): string[] {
  const issues: string[] = [];
  const factText = facts.toLowerCase();
  const numbers = generated.match(/\b\d[\d,.]*\s*(%|\+|k\b|m\b|years?|yrs?)?/gi) ?? [];
  for (const n of numbers) {
    const digits = n.match(/\d[\d,.]*/)![0].replace(/[,.]+$/, '');
    if (digits.length === 1 && !/%|\+|year|yr/i.test(n)) continue; // "1 team", list numbering
    if (!factText.includes(digits)) issues.push(`Unsupported number: ${n.trim()}`);
  }
  for (const c of generated.match(CREDENTIALS) ?? []) {
    if (!factText.includes(c.toLowerCase())) issues.push(`Unsupported credential: ${c}`);
  }
  // A claim of authorisation/sponsorship in generated text is never acceptable.
  if (/\b(authori[sz]ed to work|do not require sponsorship|green card|citizen)\b/i.test(generated) && !/authori[sz]ed|citizen|sponsor/i.test(factText)) {
    issues.push('Mentions work authorisation not present in your profile');
  }
  return [...new Set(issues)];
}
