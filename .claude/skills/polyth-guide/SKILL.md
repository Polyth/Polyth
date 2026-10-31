---
name: polyth-guide
description: Route Polyth development, design, debugging, mobile, security and review work to the repository's canonical domain skills without loading the whole documentation library.
---
# Polyth guide

Read repository-root `AGENTS.md` if not already loaded. Treat arguments as a task/area, not shell syntax. Read `docs/agents/README.md` to choose an area; with a shell, `node scripts/agent-kit.mjs context <area>` prints its paths. Read that area's actual `.agents/skills/polyth-<area>/SKILL.md` body and directly needed references. The path notation is descriptive; use an existing named directory from the router.

For example, mobile goes to `polyth-mobile`; layout to `polyth-design` plus `polyth-web-ui`; a failing command to `polyth-debug` plus its owning area; a shared runtime change to `polyth-harnesses` plus `polyth-sessions`. Load security when trust/Space boundaries change. Do not read all skills.

This single dispatcher avoids copies of 27 skills and duplicate discovery in clients that scan both `.agents` and `.claude`. It does not add tools, grant permissions, run commands automatically or certify the current state of the code. Follow the selected skill's evidence and verification requirements.
