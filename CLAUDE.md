# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

`timetable-ai` is the user's **military shift-roster web app** (교대근무 근무표 작성기, first built in
[sejoor12345-commits/timetable](https://github.com/sejoor12345-commits/timetable), developed further as `Study-05` of the
[VibeCoding](https://github.com/sejoor12345-commits/VibeCoding) study repo and moved here to deploy on Vercel). It adds
**AI via the OpenRouter API** so each person's natural-language preferences (e.g. "A는 주말 주간 선호", "B는 주 비 주 비 주 야 비 흐름 선호") shape
the auto-generated roster.

- `PRD.md` — the original roster rules (shifts, 위로휴가, 필수 조건, 벌점, UI). Still the source of truth for rules.
- `PRD_step1.md` — the AI preference feature (written by `product-manager`). Where it differs from `PRD.md`, it wins.

## Architecture decisions (made with the user's request in mind — keep them)

- **Hybrid, not "LLM writes the roster".** An LLM filling a 28–35 day roster routinely breaks hard rules (야간 다음
  날 주간, 야야야, 인원 공백) and miscounts 위로휴가 hours. So the AI does what it's good at — reading free-text
  preferences and turning them into **structured preference rules** (a small closed set of rule types) — and the
  existing rule engine in `index.html` (`computePenalty`, `createAutoFiller`) does the search, with a new
  **preference penalty** term. Hard constraints are never relaxed for a preference; preferences rank below
  인원 공백·필수 조건, 위로휴가 목표, 기준 근무 개수 and 야야.
- **Model:** `stealth/space-bunny-alpha` (user's choice). One constant in the Python client; don't change it.
- **Key:** only from env var `OPENROUTER_API_KEY`, copied from Colab 보안 비밀 (🔑) in a notebook cell
  (see `PRD_step1.md` §8 for the Colab cells). The key never reaches the browser.
- **Server:** `timetable_server/` — Python standard library `http.server` + `requests` (both preinstalled on
  Colab, so no install step). It serves `index.html` at `/` and the AI endpoints under `/api/`. In Colab it runs
  in the background and is opened with `google.colab.output.serve_kernel_port_as_window(<port>)`; the page calls the
  API with relative URLs, so it works through the Colab proxy.
- **`index.html` stays one self-contained file** (HTML+CSS+JS inline, no CDN/external libraries, Chrome/Edge,
  phone width). Double-clicked offline it must still do everything it did before, including applying preference
  rules already saved in it (localStorage copy + backup code); only the AI buttons need the Colab server, and they say so.
- **Data lives in Supabase** (cloud save, see below); localStorage is kept as the offline copy, not removed.
- **Privacy:** only the preference text, the people's names and the period dates go to OpenRouter — not the roster.
  The UI reminds the user to use pseudonyms (A, B, C…), never real names or unit info.

## Rules carried over from the original repo

- Calculation logic (hours, 위로휴가, rule checks, penalties, preference scoring) lives in functions that take
  inputs and return results — no DOM reads/writes. UI code only calls them and renders.
- Test data uses pseudonyms A, B, C, D, E only.
- The built-in `runTests()` in `index.html` (run from the browser console) must keep passing; extend it for
  new calculation functions.
- There is no Excel/VBA version here (the original repo's `excel/` was dropped on purpose).

## Deployment

- **Vercel** serves the repo root as a static site (Framework Preset: Other, no build command, Root Directory
  empty): `/` → `index.html`. The AI server does not run there, so on Vercel the 선호도 tab shows "AI 서버에 연결하지
  못했어요" and everything else (manual input, checks, auto-generation, saved preference rules) works. Running the AI on
  Vercel would need a serverless function + the key in Vercel env vars + some access protection — not done yet.
- **Colab** runs `timetable_server/server.py` (serves `index.html` + `/api/*`) — the only place the AI works today.
- Data follows the **저장 코드** (Supabase), not the origin: on a new origin/device the page starts a new code, and the
  user loads the old one with [다른 코드로 불러오기] (or the backup code, which still works).

## Supabase (cloud save)

- Project `ixwevjgmjoclxflshbjj` (region ap-southeast-1). Managed from Claude through the **claude.ai Supabase
  connector** (`mcp__Supabase__*`) — the repo's `.mcp.json` was removed on purpose; the connector needs no network
  allowlist or OAuth in the container.
- Schema is `supabase/rosters.sql` (applied as migration `create_rosters`): table `public.rosters(code, data jsonb,
  updated_at)` with RLS on and **no policies**, so the browser can't touch the table; it only calls the
  `SECURITY DEFINER` functions `load_roster(p_code)` / `save_roster(p_code, p_data)` over REST (`/rest/v1/rpc/…`,
  plain `fetch`, no supabase-js). Knowing the 16-char 저장 코드 = access to that roster. The advisor warnings about
  anon executing SECURITY DEFINER functions are intentional. Schema changes go through `apply_migration` and must
  keep `supabase/rosters.sql` in sync.
- `index.html` holds `SUPABASE_URL` and the **publishable** key (public by design). Never put a service-role/secret key
  there — anything in that file is public on Vercel.
- Sync (`index.html`, "클라우드 저장"): the local copy renders first, then `load_roster`; edits are debounced (1.5 s)
  and pushed with `save_roster`. Unpushed edits are flagged in localStorage (`timetable-cloud-dirty`) and win over the
  cloud copy on the next successful connection; otherwise the cloud copy wins. Last write wins across devices.
  Undo history (`timetable-auto-v2`) stays local only, like the backup code.
- This container can't reach `*.supabase.co` (proxy 403), so the app's sync is tested with Playwright `page.route`
  faking the two RPCs; the DB side is tested through the connector (`execute_sql` with `set local role anon`).

## Testing

No API key here and `openrouter.ai` is blocked, so AI calls are verified against fakes: patch `requests.post`
(e.g. a `sitecustomize.py` on `PYTHONPATH` in the server process) or point the client at a local fake OpenRouter server. Browser checks use the global Node
Playwright (`/opt/node22/lib/node_modules/playwright`, Chromium at `/opt/pw-browsers`). Real AI quality/speed is
checked by the user in Colab.

## Subagent team (`.claude/agents/`)

Five subagents, all `model: inherit` with no `tools` line (= all tools), loaded when this repo is the working
directory. Their prompts are in Korean and each ends with a Korean report format.

| Agent | Role |
|---|---|
| `product-manager` | Owns the schedule; writes `PRD_step1.md`, `PRD_step2.md`, … (same outline as `PRD_step1.md`), tags each requirement with its owner. Writes docs, not app code. |
| `ai-integration-specialist` | OpenRouter client (one file, model name as one constant), prompts, generation/summarization. Keeps the lessons already in the client (total-time deadline, `<think>` stripping, friendly 401/429/5xx messages). |
| `backend-developer` | Server/API, data processing and storage (Google Drive in Colab, atomic writes), non-AI external services, security. Calls the AI specialist's functions instead of writing its own OpenRouter code. |
| `frontend-developer` | UI, responsive layout (narrow sajibang browser via Colab), accessibility, UI performance. Calls backend/AI functions; no data or AI code in UI files. |
| `qa-engineer` | Tests PRD completion criteria, error handling (fake 401/429/5xx/timeout/empty responses), performance, code review, usability — and **fixes the bugs it finds**, re-testing until they're resolved. |

Intended flow per step: `product-manager` → `ai-integration-specialist` / `backend-developer` /
`frontend-developer` → `qa-engineer`. None of them commit or push; the caller decides. Subagents can't ask the user
directly, so open decisions come back in their reports ("사용자에게 물어볼 것") for the main session to relay.

## Current state

- Step 1 (AI preference feature) is **built and QA'd**: `timetable_server/` (server + OpenRouter client + prompts) and
  `index.html` (preference scoring, 선호도 tab, result card). `runTests()` = 224 passing; with no rules the auto-generator
  is identical to the imported original (same seed → same roster). The user still has to check real-AI quality in Colab
  (PRD_step1 §9.1) — the container has no key.
- Cloud save (Supabase) is built and tested against a faked Supabase; the real round trip is checked by the user on
  Vercel/Colab (this container can't reach supabase.co).
- Known limits (not bugs, QA-measured): 야야/위로휴가 misses on tight setups (5명·4주·전원 목표 3) come from the time-boxed
  search on slow PCs, same as the original; few weak rules barely move the result, and pressing [다시 생성] repeatedly
  improves it (it only accepts a lower total penalty).
- Open ideas the user hasn't decided: longer/better search, a "[다시 생성]을 더 누르면 나아질 수 있어요" hint, `aria-disabled`
  on the parse button, an "예시 글 넣기" button.
- Test scripts were kept out of the repo on purpose; QA's matrix is PRD_step1 §9.2. Browser checks use the global Node
  Playwright; fake the AI by patching `requests.post` in the server process (e.g. `sitecustomize.py` on `PYTHONPATH`).

## Talking to the user

- The user is a coding beginner learning vibe coding, studying in a military PC room (사지방): no local terminal or
  editor. They run code by cloning into **Google Colab**, so give Colab code cells, not terminal commands.
- Answer in Korean, explain jargon in plain words, keep side details light.
- Commit messages: Korean summary.
