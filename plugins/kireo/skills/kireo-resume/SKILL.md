---
name: kireo-resume
description: Load previously saved project context to continue work, including constraints, open threads and decisions.
---

# kireo-resume

## Identify the project

Call project_info and show its key and source so the user can check the project identity.

Actively call project_info and context_load; results are not preloaded.

## Load context

Call context_load and display the returned text without paraphrasing, reordering or dropping group headings.

Display the text returned by context_load without reordering or dropping sections. Its order is Constraints → Open threads → Decisions → Gotchas → Key files → Preferences.

Keep the code-index freshness line: it tells the user whether the index exists and how old it is.

Explain markers accurately: [uncertain] means the original evidence was not verified, so do not present it as confirmed fact. [stale] means an open thread has not changed for over 90 days; it may no longer apply, but it is not necessarily false.

An empty project is normal. Explain that no structured context has been saved and suggest the save command. It is not a loading failure. Preserve stored content and use English for operational guidance by default, unless the user requests another language.
