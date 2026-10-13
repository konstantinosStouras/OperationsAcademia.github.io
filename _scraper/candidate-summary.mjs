/* Count each profile once per broad category, including common legacy labels. */
export function researchSummary(rows) {
  const groups = [
    { label: 'Machine learning', matches: /^(machine learning(?: and data science)?|deep learning)$/i },
    { label: 'Optimization', matches: /^(operations research\s*\/\s*optimization|operations research|optimization|ai for operations research)$/i },
    { label: 'Healthcare operations', matches: /^healthcare operations$/i },
  ];
  return groups.map(({ label, matches }) => ({ label, count: rows.filter(row =>
    (row.researchAreas || []).some(area => matches.test(String(area).trim()))).length
  })).filter(area => area.count > 0);
}
