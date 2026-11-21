export function validateEtlBatch(parsed, options = {}) {
  const confidenceThreshold = options.confidenceThreshold ?? 0.85
  const requiredFields = options.requiredFields ?? ['orderId', 'amountCents']
  const issues = []
  const seenKeys = new Set()
  let computedTotalCents = 0

  const rows = (parsed.records ?? []).map((row) => {
    const rowIssues = []
    for (const req of requiredFields) {
      const val = row[req]
      if (val === null || val === undefined || val === '') {
        rowIssues.push({ field: req, code: 'MISSING_REQUIRED', message: `Missing required field "${req}"` })
      }
    }

    for (const [field, score] of Object.entries(row.confidence ?? {})) {
      if (typeof score === 'number' && score > 0 && score < confidenceThreshold) {
        rowIssues.push({
          field,
          code: 'LOW_CONFIDENCE',
          confidence: score,
          message: `Field "${field}" confidence ${score} < ${confidenceThreshold} (needs human review)`,
        })
      }
    }

    if (
      typeof row.qty === 'number' &&
      typeof row.unitPriceCents === 'number' &&
      typeof row.amountCents === 'number'
    ) {
      const expected = Math.round(row.qty * row.unitPriceCents)
      if (expected !== row.amountCents) {
        rowIssues.push({
          field: 'amountCents',
          code: 'LINE_MATH_MISMATCH',
          message: `Expected qty*unitPrice=${expected} cents, got ${row.amountCents} cents`,
        })
      }
    }

    if (typeof row.amountCents === 'number') {
      computedTotalCents += row.amountCents
    }

    const dedupKey = `${row.orderId ?? ''}::${row.item ?? ''}`
    if (row.orderId && seenKeys.has(dedupKey)) {
      rowIssues.push({
        field: 'orderId',
        code: 'DUPLICATE_ROW_KEY',
        message: `Duplicate order+item key "${dedupKey}"`,
      })
    }
    if (row.orderId) seenKeys.add(dedupKey)

    for (const issue of rowIssues) {
      issues.push({ rowId: row.rowId, ...issue })
    }
    return {
      ...row,
      reviewStatus: rowIssues.length > 0 ? 'needs-review' : 'validated',
      issues: rowIssues,
    }
  })

  const declaredTotalCents = parsed.declaredTotals?.length > 0 ? parsed.declaredTotals[0].amountCents : null
  const totalMismatchCents =
    typeof declaredTotalCents === 'number' ? declaredTotalCents - computedTotalCents : 0
  if (typeof declaredTotalCents === 'number' && totalMismatchCents !== 0) {
    issues.push({
      rowId: 'SUMMARY',
      field: 'amountCents',
      code: 'TOTAL_RECONCILIATION_MISMATCH',
      message: `Declared total ${declaredTotalCents} != extracted sum ${computedTotalCents} (delta ${totalMismatchCents})`,
    })
  }

  return {
    rows,
    issues,
    summary: {
      rowCount: rows.length,
      needsReviewCount: rows.filter((r) => r.reviewStatus === 'needs-review').length,
      computedTotalCents,
      declaredTotalCents,
      totalMismatchCents,
    },
  }
}
