# Gate G5: the shareable demo (P5)

**Verdict: PASS** (2026-10-14)

## Fresh-clone path
- Repo copied with rsync, excluding .gitignore entries (equivalent to a clone), into a scratch dir.
- `docker compose -p loomg5 up -d --build` with ports remapped (falkordb 6390/3090, daemon 4428/4427).
- `docker compose exec daemon node packages/cli/dist/loom.cjs replay demo/run-1 --speed 0` sent **56/56** events with 0 failures. Status: done.
- `/runs` lists the replay run.
- The replay graph matches the source run `loom-mv7y0ybo`:
  - notices a→b and a→c, both resolved;
  - Changes: a behavior 1, a contract 1, b behavior 1;
  - 10910 symbols.

## Read-only public mode
- Container env: `LOOM_READONLY=1 LOOM_TENANT=public LOOM_AUTOREPLAY=demo/run-1 PORT=8080`.
- Autoreplay on boot created `public:replay:mv7zqny4`.
- `POST /admin/runs` returns 403. `POST /replay {dir:/etc}` returns 403 (outside replayRoots).
- Screenshots are taken from that container:
  - `live.jpg`: graph, agents a/b/c, resolved 2, event list;
  - `timeline.jpg`: per-agent columns, with notices at t+3.1s;
  - `why.jpg`: decision → task → agent a → contract → commit for `django/utils/text.py::slugify`.
- The Verify view shows "No claims yet". The demo recording predates `claim_done` (P4), so this is expected.

## Not done (needs Abhinav)
- Deploy to Railway (`railway.toml` is ready) and FalkorDB Cloud. Both need accounts.
- Making the repo public.
