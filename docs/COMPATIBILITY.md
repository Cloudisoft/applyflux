# Platform compatibility matrix

Status as of this release. "Auto-submit" means Auto Mode may click the final submit button; it also requires the platform id in `AUTO_SUBMIT_PLATFORMS` (default: `sandbox` only).

| Platform | Detect | Fill | Multi-step | Attach files | Auto-submit capable | How it was tested |
|---|---|---|---|---|---|---|
| ApplyFlux Sandbox | ✅ | ✅ | ✅ | ✅ | ✅ (enabled) | **End-to-end** in Chromium with the built extension: single page, 3-step, CAPTCHA before form, CAPTCHA at submit, validation error, no confirmation, sign-in wall |
| Greenhouse (hosted & job-boards) | ✅ | ✅ | n/a | ✅ | capable, **off by default** | jsdom fixture tests modelled on live markup; read-only detection/mapping check against a live posting (all standard fields + 9 screening questions mapped correctly) |
| Lever | ✅ | ✅ | n/a | ✅ | capable, **off by default** | jsdom fixture tests; read-only check against a live posting (all standard fields + 12 custom questions identified) |
| Ashby | ✅ | ✅ | n/a | ✅ | ❌ | Adapter + generic engine; not validated against a live form |
| Workday | ✅ | ✅ | ✅ (repeating work history/education) | ✅ | ❌ | jsdom fixture of the experience step. Most tenants require account sign-in → ApplyFlux pauses (`login_required`) |
| iCIMS | ✅ | ✅ | ✅ | ✅ | ❌ | Adapter + generic engine; not validated against a live form |
| Company career pages (generic) | ✅ | ✅ | ✅ | ✅ | ❌ | Generic engine; Review/Assisted only |
| LinkedIn (incl. Easy Apply) | ✅ | ❌ | ❌ | ❌ | ❌ | **Not automated**: LinkedIn's User Agreement prohibits automated access. Detected and handed to the person; tracked manually |

**Never submitted to real employers during testing.** Live checks were read-only HTTP GETs of public job pages and public job-board APIs.

## Job discovery sources
| Source | Status |
|---|---|
| Greenhouse public board API | ✅ verified live (read-only) |
| Lever public postings API | ✅ verified live (read-only) |
| Ashby public posting API | ✅ verified live (read-only) |
| Manual import / extension "Save job" | ✅ |
| LinkedIn, Indeed, other logged-in boards | ❌ not integrated |
