# SpendPulse — Invoice Monitor & Price Intelligence

Autonomous invoice ingestion and procurement price-intelligence tool for wholesale food & beverage operations. Upload scanned receipts / PDF invoices / photos (or connect a local folder), and SpendPulse uses multimodal OCR (DeepSeek by default, Gemini optional) to extract every line item, normalizes vendor aliases into a canonical master product catalog, and automatically flags price increases across vendors.

## Features

- **Multimodal OCR** — extracts line items across all pages of multi-page PDFs, scanned photos, and ZIP archives. PDF pages are rasterised to images **in the browser** (image-only providers such as DeepSeek cannot read PDF data), so the server never renders documents itself.
- **Swappable AI provider** — `LLM_PROVIDER=deepseek|gemini`; DeepSeek uses the vision-capable `deepseek-flash` model via the OpenAI-compatible API.
- **Long-document safe** — invoices longer than `OCR_PAGES_PER_REQUEST` (default 6) pages are split into chunks and merged, so 40-page distributor statements complete instead of hitting output-token limits.
- **Alias canonicalization** — 3-tier matcher (exact SKU → token/pack-size rules → batch AI semantic) maps vendor-specific descriptions to a single master product.
- **Automatic item grouping** — identical rows inside one invoice are merged into a single line (quantities/totals summed), and identical items seen across invoices are auto-linked to the same master product — including when the catalog is still empty.
- **Source document archive** — every uploaded page is stored under `data/documents/<invoiceId>/`, so clicking an invoice row opens the original scan beside the extracted data for verification (page switcher + zoom).
- **Price intelligence** — detects price increases vs. previous purchases, records price history, and raises alerts you can acknowledge / dispute.
- **Conversational copilot** — ask natural-language questions about spend, vendor trends, and cost forecasts over your local data.
- **Exports** — dump the database to CSV, JSON, or SQL.
- **Folder monitor** — uses the browser File System Access API to watch a local folder and ingest new invoices automatically (supported browsers only).

## Prerequisites

- Node.js 18+ (or Bun)
- A DeepSeek API key (default) or a Gemini API key

## Run locally

```bash
npm install
cp .env.example .env.local      # then set DEEPSEEK_API_KEY=your_key (or GEMINI_API_KEY + LLM_PROVIDER=gemini)
npm run dev                     # starts on http://127.0.0.1:3000
```

Other scripts:

```bash
npm run build      # production build (vite)
npm start          # run the compiled server
npm run lint       # tsc --noEmit (type-check)
```

> The server binds to `127.0.0.1` by default. `POST /api/reset-data` wipes all local data — keep it on localhost / behind auth before exposing the port.

## Notes

- Data is stored in `data/database.json` (git-ignored). Reset from the UI footer or `POST /api/reset-data` — this also deletes the archived source documents.
- Archived invoice pages live in `data/documents/` (git-ignored, capped by `DOCUMENT_STORE_MAX_MB`, default 120 MB per invoice) and are served from `/api/invoices/:id/pages/:pageNumber`.
- OCR and chat require a valid API key for the active provider; both degrade gracefully if the model is rate-limited.
