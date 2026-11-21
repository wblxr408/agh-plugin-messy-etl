---
name: fde-messy-etl
description: Provenance-preserving extraction and reconciliation playbook for dirty spreadsheets and OCR.
---

# Messy Document & Spreadsheet ETL Playbook

1. **Preserve Provenance**: Always keep row/column cell coordinates (`Sheet1-R4`) or OCR line numbers when presenting extracted data.
2. **Never Silently Guess Low-Confidence Cells**: Any merged-cell forward-fill (`confidence < 0.85`), OCR noise, or `qty * unitPrice !== amountCents` math discrepancy must stay flagged `needs-review` until confirmed via `fde_etl_patch_row`.
3. **Reconcile Totals Separately**: Separate summary rows (`合计`/`Total`) from line items and verify `declaredTotalCents === computedTotalCents` before committing (`fde_etl_commit_batch`).
