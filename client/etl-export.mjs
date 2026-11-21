const columns = ['orderId', 'vendor', 'item', 'quantity', 'unitPriceCents', 'amountCents']

function cell(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  let text = String(value ?? '')
  if (/^[\s]*[=+\-@]|^[\t\r\n]/u.test(text)) text = "'" + text
  return '"' + text.replaceAll('"', '""') + '"'
}

export function etlCsv(batch) {
  if (batch.status !== 'committed') throw new Error('Only a confirmed batch can be exported.')
  return [columns.join(','), ...batch.rows.map((row) => columns.map((key) => cell(row[key])).join(',')), ''].join('\r\n')
}
