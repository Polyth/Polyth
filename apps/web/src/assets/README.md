# Web app assets

Where each bundled asset comes from and under which license it ships. Add a
row when adding an asset that is not plain project code.

| Asset | Origin | License |
| --- | --- | --- |
| `completion.mp3`, `completionSound.ts` | Synthesized from sine partials by [`scripts/completion-sound.mjs`](../../../../scripts/completion-sound.mjs); rerun it to change the chime. | Apache-2.0 (the repository license) |
| `project-icons/*.svg` | Supplied by the project owner, who confirmed the right to ship them under the repository license (2026-10-28). | Apache-2.0 (the repository license) |
| `fonts/*.woff2` | Upstream font families, listed in [fonts/README.md](fonts/README.md). | SIL OFL 1.1, see [fonts/OFL.txt](fonts/OFL.txt) |
