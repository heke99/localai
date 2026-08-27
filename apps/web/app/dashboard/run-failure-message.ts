export function runFailureMessage(code: string): string {
  const value = code.trim().toLowerCase();
  if (!value) return "Körningen kunde inte slutföras. Försök igen.";

  if (/current-information|web[-_ ]?(?:search|fetch)|current[-_ ]?time|research[-_ ]?evidence/.test(value)) {
    return "Aktuell information kunde inte hämtas eller verifieras tillräckligt. Försök igen.";
  }
  if (/timeout|timed_out|model_turn_limit|tool_loop_limit|429|capacity|overload|busy/.test(value)) {
    return "Körningen tog för lång tid eller kapaciteten var tillfälligt upptagen. Försök igen.";
  }
  if (/503|502|unavailable|connection|network|inference/.test(value)) {
    return "Modelltjänsten eller en nödvändig anslutning svarade inte. Försök igen.";
  }
  if (/permission|access|forbidden|resource|grant|authentication|unauthori[sz]ed/.test(value)) {
    return "En vald resurs eller anslutning saknar nödvändig åtkomst. Kontrollera valet och försök igen.";
  }
  if (/verification_gate_failed|completion-proof|verification_loop/.test(value)) {
    return "Svaret kunde inte verifieras säkert nog för att slutföras. Försök igen eller precisera uppgiften.";
  }
  if (/cancel/.test(value)) return "Körningen stoppades.";

  return "Körningen kunde inte slutföras. Försök igen.";
}
