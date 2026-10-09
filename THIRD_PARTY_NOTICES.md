# Third-party notices

ApplyFlux adapts code and design ideas from **career-ops** (https://github.com/career-ops-hq/career-ops), used under the MIT License:

- `packages/shared/src/vendor/liveness-core.ts` — ported from `liveness-core.mjs` (posting liveness classification, bot-wall detection).
- `packages/shared/src/url.ts` — adapted from `url-key.mjs` (canonical posting URL key) and `ats-vendor.mjs` (ATS host detection).
- `packages/shared/src/text.ts` — synonym groups and boundary-aware matching from `keyword-match.mjs`.
- `apps/server/src/services/discovery.ts` — Greenhouse / Lever / Ashby public board integration and SSRF hardening modelled on `providers/greenhouse.mjs`, `lever.mjs`, `ashby.mjs`.
- `apps/server/src/ai/prompts.ts` — the "sources of truth", "keywords reformulated, never fabricated" and "untrusted external content" rules from `modes/_shared.md` / `AGENTS.md`.

```
MIT License

Copyright (c) 2026 Santiago Fernández de Valderrama

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
