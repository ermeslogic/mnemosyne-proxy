const domains: Record<string, RegExp> = {
  coding: /\b(codice|coding|software|programmazione|python|typescript|javascript|database|mysql|postgres(?:ql)?|api|repo|git|server|bug|sqlite|deploy|sql|programming|code|framework)\b/giu,
  business: /\b(azienda|business|cliente|clienti|fattura|investitore|investimento|vendite|partner|ricavi|margine|sales|revenue|investor|invoice|customer|budget|pricing|commerciale)\b/giu,
  personal: /\b(famiglia|vacanza|compleanno|figlio|figlia|casa|sorella|fratello|viaggio|family|birthday|holiday|sister|brother|personal|personale|vacation)\b/giu,
};

export function validScope(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value);
}

export function contextNamespace(input: string, explicit: string | undefined, session: string): string {
  if (explicit) return 'explicit/' + explicit;
  const ranked = Object.entries(domains).map(([domain, pattern]) => [
    domain,
    new Set(Array.from(input.matchAll(pattern), match => match[0].toLowerCase())).size,
  ] as const).sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] > ranked[1][1]) return 'auto/' + ranked[0][0];
  return 'session/' + session;
}
