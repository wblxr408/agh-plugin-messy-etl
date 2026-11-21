import React from 'react'
import { etlCsv } from './etl-export.mjs'

const strings = {
  en: {
    title: 'Messy Document & Spreadsheet ETL Review',
    refresh: 'Refresh',
    empty: 'No ETL batches staged.',
    rawSource: 'Original Source (Provenance View)',
    extracted: 'Extracted Rows (Low-confidence flagged)',
    fixAmount: 'Patch Amount (cents)',
    applyPatch: 'Apply Patch',
    commit: 'Commit Batch',
    exportCsv: 'Export confirmed CSV',
    loading: 'Loading ETL batches…',
    saving: 'Updating batch…',
  },
  'zh-CN': {
    title: '脏文档与复杂表格结构化核对台',
    refresh: '刷新',
    empty: '暂无待核对的解析批次。',
    rawSource: '原件文本（溯源对照）',
    extracted: '提取结果（低置信度标红复核）',
    fixAmount: '修正金额（分）',
    applyPatch: '保存修正',
    commit: '确认提交批次',
    exportCsv: '导出已确认 CSV',
    loading: '加载解析批次…',
    saving: '更新批次中…',
  },
}

const h = React.createElement

export function apply(ctx, config) {
  const services = ctx.profile.services
  const pendingKey = JSON.stringify(['fde.etl', config.binding, config.revision])

  function readPending() {
    return JSON.parse(window.sessionStorage.getItem(pendingKey) ?? 'null')
  }

  function MessyEtlReviewPage() {
    const locale = React.useSyncExternalStore(ctx.locale.subscribe, () => ctx.locale.locale)
    const t = strings[locale] ?? strings.en
    const [batches, setBatches] = React.useState([])
    const [patchValues, setPatchValues] = React.useState({})
    const [busy, setBusy] = React.useState(true)
    const [error, setError] = React.useState('')
    const [operation, setOperation] = React.useState(readPending)
    const live = React.useRef(false)
    const locked = React.useRef(false)

    const load = React.useCallback(async () => {
      const res = await services.query('fde.etl.batches', {})
      if (live.current) setBatches(res.batches ?? [])
    }, [])

    const runWork = React.useCallback(async (work) => {
      if (locked.current) return
      locked.current = true
      setBusy(true)
      setError('')
      try {
        await work()
      } catch (err) {
        if (live.current) setError(err instanceof Error ? err.message : 'Request failed')
      } finally {
        locked.current = false
        if (live.current) setBusy(false)
      }
    }, [])

    const settle = React.useCallback(
      async (result) => {
        const final = ['completed', 'refused', 'cancelled'].includes(result.state)
        if (final) window.sessionStorage.removeItem(pendingKey)
        if (!live.current) return
        if (final) setOperation(null)
        if (result.state === 'completed') {
          await load()
        } else {
          setError(`Status: ${result.state}`)
        }
      },
      [load],
    )

    React.useEffect(() => {
      live.current = true
      void runWork(async () => {
        const saved = readPending()
        if (saved) {
          const receipt = await services.readOperation(saved.service, saved.operationId)
          await settle(receipt)
        }
        await load()
      })
      return () => {
        live.current = false
      }
    }, [load, runWork, settle])

    function dispatchEffect(service, input) {
      if (busy || operation) return
      const next = { service, operationId: crypto.randomUUID(), input }
      void runWork(async () => {
        window.sessionStorage.setItem(pendingKey, JSON.stringify(next))
        setOperation(next)
        const result = await services.effect(service, input, { operationId: next.operationId })
        await settle(result)
      })
    }

    const blocked = busy || operation !== null
    return h(
      'section',
      { 'aria-label': t.title },
      h('h1', null, config.publicConfig?.label ?? t.title),
      busy && h('p', { role: 'status' }, batches.length ? t.saving : t.loading),
      error && h('p', { role: 'alert' }, error),
      h('button', { type: 'button', disabled: busy, onClick: () => void runWork(load) }, t.refresh),
      batches.length === 0
        ? h('p', null, t.empty)
        : batches.map((batch) =>
            h(
              'div',
              { key: batch.batchId, 'data-batch-id': batch.batchId },
              h(
                'h2',
                null,
                `${batch.batchId} (${batch.fileName}) [${batch.status}] — needsReview: ${batch.summary?.needsReviewCount ?? 0}, delta: ${batch.summary?.totalMismatchCents ?? 0}`,
              ),
              h('h3', null, t.rawSource),
              h('pre', null, batch.rawSource ?? ''),
              h('h3', null, t.extracted),
              h(
                'ul',
                null,
                (batch.rows ?? []).map((row) => {
                  const key = `${batch.batchId}:${row.rowId}`
                  return h(
                    'li',
                    { key: row.rowId, 'data-row-id': row.rowId },
                    h(
                      'span',
                      null,
                      `${row.rowId} · orderId=${row.orderId ?? ''} · amountCents=${row.amountCents ?? 'null'} [${row.reviewStatus}]`,
                    ),
                    row.reviewStatus === 'needs-review' &&
                      batch.status !== 'committed' &&
                      h(
                        'span',
                        null,
                        h('input', {
                          'aria-label': `${t.fixAmount} ${row.rowId}`,
                          value: patchValues[key] ?? '',
                          disabled: blocked,
                          onInput: (e) => {
                            const val = e.currentTarget.value
                            setPatchValues((prev) => ({ ...prev, [key]: val }))
                          },
                        }),
                        h(
                          'button',
                          {
                            type: 'button',
                            disabled: blocked || !patchValues[key],
                            onClick: () =>
                              dispatchEffect('fde.etl.patch', {
                                batchId: batch.batchId,
                                rowId: row.rowId,
                                patch: { amountCents: Number.parseInt(patchValues[key], 10) },
                              }),
                          },
                          t.applyPatch,
                        ),
                      ),
                  )
                }),
              ),
              batch.status === 'committed' &&
                h('button', {
                  type: 'button',
                  onClick: () => {
                    const csv = new Blob(['\uFEFF', etlCsv(batch)], { type: 'text/csv;charset=utf-8' })
                    const url = URL.createObjectURL(csv)
                    const link = document.createElement('a')
                    link.href = url
                    link.download = 'confirmed-etl.csv'
                    link.click()
                    setTimeout(() => URL.revokeObjectURL(url), 1000)
                  },
                }, t.exportCsv),
              batch.status !== 'committed' &&
                h(
                  'button',
                  {
                    type: 'button',
                    disabled:
                      blocked ||
                      (batch.summary?.needsReviewCount ?? 0) > 0 ||
                      (batch.summary?.totalMismatchCents ?? 0) !== 0,
                    onClick: () => dispatchEffect('fde.etl.commit', { batchId: batch.batchId }),
                  },
                  t.commit,
                ),
            ),
          ),
    )
  }

  ctx.homeEntries.register({
    id: 'messy-etl-review',
    icon: 'plugin',
    titleKey: 'Messy ETL Review',
    order: 43,
    placement: 'secondary',
    component: MessyEtlReviewPage,
  })
}
