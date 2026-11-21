/**
 * Messy spreadsheet and semi-structured OCR document parser with exact cell/line provenance.
 */

const HEADER_ALIASES = {
  orderId: ['orderid', 'order_id', 'orderno', '订单号', '单据号', '单据编号', '采购单号'],
  vendor: ['vendor', 'supplier', '供应商', '往来单位', '客户名称'],
  item: ['item', 'sku', 'product', '品名', '物料名称', '商品名称', '摘要'],
  qty: ['qty', 'quantity', '数量'],
  unitPrice: ['unitprice', 'unit_price', 'price', '单价', '含税单价'],
  amount: ['amount', 'total', '金额', '含税金额', '价税合计'],
  date: ['date', 'orderdate', '日期', '单据日期'],
}

const SUMMARY_MARKERS = /^(?:合计|总计|小计|total|grand\s*total|subtotal)(?:$|\s|[:：])/i

function normalizeHeaderKey(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-_()（）:：/]+/g, '')
}

export function resolveFieldName(headerText) {
  const norm = normalizeHeaderKey(headerText)
  if (!norm) return null
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    if (
      aliases.some((alias) => norm === normalizeHeaderKey(alias) || norm.includes(normalizeHeaderKey(alias)))
    ) {
      return canonical
    }
  }
  return norm
}

export function parseCsvGrid(rawText) {
  const clean = String(rawText ?? '').replace(/^\uFEFF/, '')
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return []
  const delimiter = lines[0].includes('\t') && !lines[0].includes(',') ? '\t' : ','

  const parseLine = (line) => {
    const cells = []
    let cur = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = !inQuotes
        }
        continue
      }
      if (ch === delimiter && !inQuotes) {
        cells.push(cur.trim())
        cur = ''
        continue
      }
      cur += ch
    }
    cells.push(cur.trim())
    return cells
  }

  return lines.map(parseLine)
}

export function parseMoneyToCents(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { cents: Math.round(raw * 100), confidence: 0.99 }
  }
  const text = String(raw ?? '').trim()
  if (!text) return { cents: null, confidence: 0 }
  const isParenNegative = /^\(.*\)$/.test(text)
  const stripped = text
    .replace(/^\((.*)\)$/, '$1')
    .replace(/(?:RMB|CNY|USD|EUR|¥|\$|€|元)/gi, '')
    .replace(/,/g, '')
    .trim()
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(stripped)) {
    return { cents: null, confidence: 0.25 }
  }
  const num = Number.parseFloat(stripped)
  if (!Number.isFinite(num)) return { cents: null, confidence: 0.2 }
  const signed = isParenNegative ? -Math.abs(num) : num
  const hasCents = /\.\d{2}$/.test(stripped)
  return { cents: Math.round(signed * 100), confidence: hasCents ? 0.98 : 0.9 }
}

export function detectHeaderRowIndex(grid) {
  let bestIdx = 0
  let bestScore = -1
  const limit = Math.min(10, grid.length)
  for (let r = 0; r < limit; r++) {
    const row = grid[r]
    let score = 0
    for (const cell of row) {
      const resolved = resolveFieldName(cell)
      if (resolved && Object.hasOwn(HEADER_ALIASES, resolved)) score += 2
      else if (String(cell).trim().length > 0) score += 0.2
    }
    if (score > bestScore) {
      bestScore = score
      bestIdx = r
    }
  }
  return bestIdx
}

export function parseMessySpreadsheet(rawText, options = {}) {
  const fileName = options.fileName ?? 'upload.csv'
  const sheetName = options.sheetName ?? 'Sheet1'
  const mergeFillColumns = new Set(options.mergeFillColumns ?? ['orderId', 'vendor', 'date'])
  const grid = parseCsvGrid(rawText)
  if (grid.length < 2) {
    throw new Error('Spreadsheet must contain at least a header row and one data row')
  }

  const headerIdx = detectHeaderRowIndex(grid)
  const rawHeaders = grid[headerIdx]
  const columns = rawHeaders.map((h, colIndex) => ({
    colIndex,
    rawHeader: h,
    field: resolveFieldName(h) ?? `col_${colIndex}`,
  }))

  const records = []
  const declaredTotals = []
  const lastSeen = {}

  for (let r = headerIdx + 1; r < grid.length; r++) {
    const cells = grid[r]
    const rowNumber = r + 1
    const firstNonEmpty = cells.find((c) => c.trim().length > 0) ?? ''
    if (SUMMARY_MARKERS.test(firstNonEmpty)) {
      const amountCol = columns.find((c) => c.field === 'amount')
      const totalParsed = amountCol ? parseMoneyToCents(cells[amountCol.colIndex]) : { cents: null }
      declaredTotals.push({
        label: firstNonEmpty,
        amountCents: totalParsed.cents,
        provenance: { file: fileName, sheet: sheetName, rowNumber, rawRow: cells },
      })
      continue
    }

    const record = {}
    const confidence = {}
    const cellProvenance = {}

    for (const col of columns) {
      const rawCell = cells[col.colIndex] ?? ''
      let value = rawCell
      let fieldConfidence = rawCell ? 0.97 : 0
      let mergedInherited = false

      if (!rawCell && mergeFillColumns.has(col.field) && lastSeen[col.field]) {
        value = lastSeen[col.field]
        fieldConfidence = 0.78
        mergedInherited = true
      } else if (rawCell && mergeFillColumns.has(col.field)) {
        lastSeen[col.field] = rawCell
      }

      if (col.field === 'amount' || col.field === 'unitPrice') {
        const parsed = parseMoneyToCents(value)
        const targetKey = col.field === 'amount' ? 'amountCents' : 'unitPriceCents'
        record[targetKey] = parsed.cents
        confidence[targetKey] = parsed.confidence
        cellProvenance[targetKey] = {
          file: fileName,
          sheet: sheetName,
          rowNumber,
          colIndex: col.colIndex + 1,
          raw: rawCell,
        }
      } else if (col.field === 'qty') {
        const num = Number(String(value).replace(/,/g, ''))
        record.qty = Number.isFinite(num) && value !== '' ? num : null
        confidence.qty = record.qty !== null ? 0.97 : 0.3
        cellProvenance.qty = {
          file: fileName,
          sheet: sheetName,
          rowNumber,
          colIndex: col.colIndex + 1,
          raw: rawCell,
        }
      } else {
        record[col.field] = value
        confidence[col.field] = fieldConfidence
        cellProvenance[col.field] = {
          file: fileName,
          sheet: sheetName,
          rowNumber,
          colIndex: col.colIndex + 1,
          raw: rawCell,
          ...(mergedInherited ? { mergedInherited: true } : {}),
        }
      }
    }

    records.push({
      rowId: `${sheetName}-R${rowNumber}`,
      ...record,
      confidence,
      provenance: {
        file: fileName,
        sheet: sheetName,
        rowNumber,
        rawRow: cells,
        cells: cellProvenance,
      },
    })
  }

  return {
    fileName,
    sheetName,
    headerRowNumber: headerIdx + 1,
    detectedColumns: columns,
    records,
    declaredTotals,
  }
}

export function parseMessyDocument(rawText, options = {}) {
  const fileName = options.fileName ?? 'invoice.txt'
  const lines = String(rawText ?? '').split(/\r?\n/)
  const fields = {}
  const confidence = {}
  const provenance = {}

  const patterns = [
    { key: 'invoiceNo', re: /(?:发票号|Invoice\s*(?:No|#)|单号)\s*[:：#]?\s*([A-Za-z0-9_-]{4,40})/i },
    { key: 'vendor', re: /(?:开票方|供应商|Vendor|From)\s*[:：]\s*(.{2,80})$/i },
    { key: 'date', re: /(?:开票日期|日期|Date)\s*[:：]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/i },
    {
      key: 'total',
      re: /(?:价税合计|总额|Total\s*Amount|Grand\s*Total)\s*[:：]?\s*([¥$€]?\s*\(?[0-9,.\-?？□~]+\)?)/i,
    },
  ]

  lines.forEach((line, idx) => {
    const trimmed = line.trim()
    if (!trimmed) return
    for (const pat of patterns) {
      const m = pat.re.exec(trimmed)
      if (!m) continue
      const hasOcrNoise = /[?？□~]/.test(trimmed)
      if (pat.key === 'total') {
        const parsed = parseMoneyToCents(m[1])
        fields.totalCents = parsed.cents
        confidence.totalCents = hasOcrNoise ? Math.min(parsed.confidence, 0.72) : parsed.confidence
        provenance.totalCents = { file: fileName, lineStart: idx + 1, lineEnd: idx + 1, snippet: trimmed }
      } else {
        fields[pat.key] = m[1].trim()
        confidence[pat.key] = hasOcrNoise ? 0.7 : 0.94
        provenance[pat.key] = { file: fileName, lineStart: idx + 1, lineEnd: idx + 1, snippet: trimmed }
      }
    }
  })

  return {
    fileName,
    fields,
    confidence,
    provenance,
    lineCount: lines.length,
  }
}
