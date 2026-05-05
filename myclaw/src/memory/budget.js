export function estimateChars(result) {
  const record = result.record || result;
  return [
    record.title,
    record.key,
    record.content,
    record.source,
    result.reason,
  ].filter(Boolean).join(' ').length + 32;
}

export function trimToBudget(results, budgetChars) {
  if (!budgetChars || budgetChars <= 0) return results;

  const kept = [];
  let used = 0;
  for (const result of results) {
    const cost = estimateChars(result);
    if (kept.length > 0 && used + cost > budgetChars) continue;
    if (kept.length === 0 && cost > budgetChars) {
      kept.push(result);
      break;
    }
    kept.push(result);
    used += cost;
  }
  return kept;
}
