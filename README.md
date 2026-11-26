# @wblxr408/messy-etl-runtime

[简体中文](README.zh-CN.md)

Provenance-preserving extraction, confidence scoring, and reconciliation ETL plugin for messy customer spreadsheets and OCR documents.

## Upgrade and open the review page

1. When a reviewed `1.0.2` release source is available, use AGH's managed package update to upgrade `@wblxr408/messy-etl-runtime` from that source. The update alone does not enable the native review page.
2. In **Settings → Application**, preview the application for runtime version `1.0.2`. It uses AGH's default branding. Check that the preview lists **Messy ETL Review** as a navigation entry.
3. Adoption replaces any application already adopted in this profile. Adopt the ETL application to add the review page without replacing AGH's default navigation or conversation.
4. Open **Messy ETL Review** from the navigation or use your existing `?page=messy-etl-review` link. Your existing ETL batches remain available.

To withdraw native access to the review page, choose **Restore official interface** in **Settings → Application**. This leaves the package installed and preserves your ETL batch data.
