import { readFileSync } from 'node:fs'
import { defineAgnesPlugin, defineTool, readOnlyTool, toolError, writeTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
import { parseMessyDocument, parseMessySpreadsheet } from './parser.mjs'
import { validateEtlBatch } from './validator.mjs'

function readBatches(store) {
  return store ? (store.get('batches') ?? []) : []
}

function saveBatch(store, batch) {
  if (!store) throw new Error('Store capability unavailable')
  return store.transaction(() => {
    const existing = store.get('batches') ?? []
    const idx = existing.findIndex((b) => b.batchId === batch.batchId)
    const next = idx >= 0 ? existing.map((b, i) => (i === idx ? batch : b)) : [...existing, batch]
    store.set('batches', next)
    return batch
  })
}

function patchRowInBatch(store, { batchId, rowId, patch }) {
  if (!store) throw new Error('Store capability unavailable')
  return store.transaction(() => {
    const existing = store.get('batches') ?? []
    const batch = existing.find((b) => b.batchId === batchId)
    if (!batch) throw new Error(`Batch not found: ${batchId}`)
    let found = false
    const updatedRecords = batch.rows.map((row) => {
      if (row.rowId !== rowId) return row
      found = true
      const nextConfidence = { ...(row.confidence ?? {}) }
      for (const key of Object.keys(patch)) nextConfidence[key] = 1
      return { ...row, ...patch, confidence: nextConfidence }
    })
    if (!found) throw new Error(`Row not found: ${rowId}`)
    const revalidated = validateEtlBatch({
      records: updatedRecords,
      declaredTotals: batch.declaredTotals,
    })
    const updatedBatch = {
      ...batch,
      rows: revalidated.rows,
      issues: revalidated.issues,
      summary: revalidated.summary,
    }
    store.set(
      'batches',
      existing.map((b) => (b.batchId === batchId ? updatedBatch : b)),
    )
    return updatedBatch
  })
}

function commitBatch(store, batchId) {
  if (!store) throw new Error('Store capability unavailable')
  return store.transaction(() => {
    const existing = store.get('batches') ?? []
    const batch = existing.find((b) => b.batchId === batchId)
    if (!batch) throw new Error(`Batch not found: ${batchId}`)
    if (batch.summary.needsReviewCount > 0 || batch.summary.totalMismatchCents !== 0) {
      throw new Error(
        `Cannot commit batch "${batchId}": ${batch.summary.needsReviewCount} row(s) need review and total delta is ${batch.summary.totalMismatchCents} cents`,
      )
    }
    const committed = { ...batch, status: 'committed', committedAt: new Date().toISOString() }
    store.set(
      'batches',
      existing.map((b) => (b.batchId === batchId ? committed : b)),
    )
    return committed
  })
}

export function createMessyEtlPlugin() {
  const playbook = readFileSync(new URL('./skills/messy-etl-playbook/SKILL.md', import.meta.url), 'utf8')

  const parseSpreadsheetTool = defineTool({
    name: 'fde_etl_parse_spreadsheet',
    description:
      'Parse messy CSV/TSV spreadsheets with preamble banners, merged group cells, Chinese/English headers, and summary rows; saves staged batch.',
    parameters: Type.Object(
      {
        batchId: Type.String({ minLength: 2, maxLength: 64 }),
        rawText: Type.String({ minLength: 1, maxLength: 200000 }),
        fileName: Type.Optional(Type.String({ maxLength: 120 })),
        sheetName: Type.Optional(Type.String({ maxLength: 64 })),
        confidenceThreshold: Type.Optional(Type.Number({ minimum: 0.5, maximum: 0.99 })),
      },
      { additionalProperties: false },
    ),
    meta: { ...writeTool, isDestructive: false, requiresApproval: 'never' },
    async execute(args, ctx) {
      ctx.signal.throwIfAborted()
      try {
        const parsed = parseMessySpreadsheet(args.rawText, {
          fileName: args.fileName,
          sheetName: args.sheetName,
        })
        const validated = validateEtlBatch(parsed, {
          confidenceThreshold: args.confidenceThreshold ?? 0.85,
        })
        const batch = saveBatch(ctx.store, {
          batchId: args.batchId,
          kind: 'spreadsheet',
          status: 'staged',
          fileName: parsed.fileName,
          sheetName: parsed.sheetName,
          headerRowNumber: parsed.headerRowNumber,
          rawSource: args.rawText,
          declaredTotals: parsed.declaredTotals,
          rows: validated.rows,
          issues: validated.issues,
          summary: validated.summary,
        })
        return { content: [{ type: 'text', text: JSON.stringify({ batch }) }], structured: { batch } }
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err))
      }
    },
  })

  const parseDocTool = defineTool({
    name: 'fde_etl_parse_document',
    description:
      'Extract key invoice/contract fields from noisy OCR or plain text with exact line provenance and confidence scores.',
    parameters: Type.Object(
      {
        rawText: Type.String({ minLength: 1, maxLength: 100000 }),
        fileName: Type.Optional(Type.String({ maxLength: 120 })),
      },
      { additionalProperties: false },
    ),
    meta: readOnlyTool,
    async execute(args, ctx) {
      ctx.signal.throwIfAborted()
      const parsed = parseMessyDocument(args.rawText, { fileName: args.fileName })
      return { content: [{ type: 'text', text: JSON.stringify(parsed) }], structured: parsed }
    },
  })

  const patchRowTool = defineTool({
    name: 'fde_etl_patch_row',
    description:
      'Apply a human-verified correction to a low-confidence or mismatched ETL row and re-run batch reconciliation.',
    parameters: Type.Object(
      {
        batchId: Type.String({ minLength: 2 }),
        rowId: Type.String({ minLength: 2 }),
        patch: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Null()])),
      },
      { additionalProperties: false },
    ),
    meta: { ...writeTool, isDestructive: false, requiresApproval: 'never' },
    async execute(args, ctx) {
      ctx.signal.throwIfAborted()
      try {
        const batch = patchRowInBatch(ctx.store, args)
        return { content: [{ type: 'text', text: JSON.stringify({ batch }) }], structured: { batch } }
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err))
      }
    },
  })

  const commitBatchTool = defineTool({
    name: 'fde_etl_commit_batch',
    description:
      'Commit a fully validated and reconciled ETL batch; fails closed if any row still needs review or totals mismatch.',
    parameters: Type.Object({ batchId: Type.String({ minLength: 2 }) }, { additionalProperties: false }),
    meta: { ...writeTool, isDestructive: false, requiresApproval: 'never' },
    async execute({ batchId }, ctx) {
      ctx.signal.throwIfAborted()
      try {
        const batch = commitBatch(ctx.store, batchId)
        return { content: [{ type: 'text', text: JSON.stringify({ batch }) }], structured: { batch } }
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err))
      }
    },
  })

  const listBatchesTool = defineTool({
    name: 'fde_etl_list_batches',
    description: 'List staged and committed ETL batches with issue counts.',
    parameters: Type.Object({}, { additionalProperties: false }),
    meta: readOnlyTool,
    async execute(_args, ctx) {
      ctx.signal.throwIfAborted()
      const batches = readBatches(ctx.store).map((b) => ({
        batchId: b.batchId,
        fileName: b.fileName,
        status: b.status,
        summary: b.summary,
      }))
      return { content: [{ type: 'text', text: JSON.stringify({ batches }) }], structured: { batches } }
    },
  })

  return defineAgnesPlugin({
    apply(ctx) {
      for (const t of [parseSpreadsheetTool, parseDocTool, patchRowTool, commitBatchTool, listBatchesTool]) {
        ctx.tools.register(t)
      }
      ctx.skills?.register({
        name: 'fde-messy-etl',
        description:
          'Provenance-preserving extraction and reconciliation playbook for dirty spreadsheets and OCR.',
        body: playbook,
      })

      ctx.services.register({
        scope: 'profile',
        kind: 'query',
        name: 'fde.etl.batches',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: {
          type: 'object',
          properties: { batches: { type: 'array' } },
          required: ['batches'],
          additionalProperties: false,
        },
        timeoutMs: 5000,
        maxResultBytes: 262144,
        async handler(_input, context) {
          return { batches: readBatches(context.store) }
        },
      })

      ctx.services.register({
        scope: 'profile',
        kind: 'effect',
        name: 'fde.etl.patch',
        inputSchema: {
          type: 'object',
          properties: {
            batchId: { type: 'string' },
            rowId: { type: 'string' },
            patch: { type: 'object' },
          },
          required: ['batchId', 'rowId', 'patch'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { batch: { type: 'object' } },
          required: ['batch'],
          additionalProperties: false,
        },
        timeoutMs: 5000,
        maxResultBytes: 131072,
        effectPolicy: {
          isDestructive: false,
          isOpenWorld: false,
          replay: 'idempotent',
          requiresApproval: 'never',
          approvalScopes: [],
        },
        async handler(input, context) {
          context.signal.throwIfAborted()
          return { batch: patchRowInBatch(context.store, input) }
        },
      })

      ctx.services.register({
        scope: 'profile',
        kind: 'effect',
        name: 'fde.etl.commit',
        inputSchema: {
          type: 'object',
          properties: { batchId: { type: 'string' } },
          required: ['batchId'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { batch: { type: 'object' } },
          required: ['batch'],
          additionalProperties: false,
        },
        timeoutMs: 5000,
        maxResultBytes: 131072,
        effectPolicy: {
          isDestructive: false,
          isOpenWorld: false,
          replay: 'idempotent',
          requiresApproval: 'never',
          approvalScopes: [],
        },
        async handler(input, context) {
          context.signal.throwIfAborted()
          return { batch: commitBatch(context.store, input.batchId) }
        },
      })
    },
  })
}

export const main = createMessyEtlPlugin()
export { parseMessyDocument, parseMessySpreadsheet, validateEtlBatch }
