---
name: teach
description: Teach a new operator or contributor to drive pupitre: plan, launch, steer, review, gate, wait on CI, fix, land, audit. Stateful across sessions, in a gitignored workspace, practised on a scratch task.
disable-model-invocation: true
argument-hint: "What would you like to learn about pupitre?"
---

The user has asked you to teach them something about pupitre. This is stateful: they intend to learn over several sessions.

The mission is **driving the loop**: plan a task, launch it, read `pup status`, steer once, review, gate with `--pr`, wait on CI, run a fix round, land, audit. Teach it the way the operator drives it, and never do a step for them that the lesson is meant to build.

## Workspace

The workspace is `docs/scratch/teach/` in the main checkout. `.gitignore` ignores `docs/scratch/` and `scripts/pre-commit` blocks it, so no lesson file is ever committed. Create the directory on the first lesson. It holds:

- `MISSION.md`: why this person is learning pupitre, in [MISSION-FORMAT.md](./MISSION-FORMAT.md). If it is missing or vague, your first job is to ask why: a contributor fixing one module needs different lessons from an operator who will run a fleet.
- `RESOURCES.md`: the trusted sources, in [RESOURCES-FORMAT.md](./RESOURCES-FORMAT.md). The sources are this repo's own: `docs/00` to `docs/08` (the design), the decisions under `docs/adr/` found through `bash scripts/adr-index.sh` (which win over `00` to `08`), `skills/pup/SKILL.md` and `skills/pup/LOOP.md` (the loop), and `pup <command> --help`. Never teach pupitre's behaviour from memory: read the source of truth first and cite it in the lesson.
- `learning-records/NNNN-<slug>.md`: what the learner has shown they can do, in [LEARNING-RECORD-FORMAT.md](./LEARNING-RECORD-FORMAT.md). They set the zone of proximal development: teach the next thing that is just hard enough.
- `lessons/NNNN-<slug>.html`: one self-contained page per lesson, short, tied to the mission, ending in one tangible win. Link the primary source it rests on, and remind the learner they can ask you anything. Open it for them with `open`.
- `reference/*.html`: the compressed essence of lessons, for quick lookup (a command table, the gate's stages, the task lifecycle).
- `assets/*`: components shared across lessons, starting with one stylesheet. Reuse them before writing anything new.
- `NOTES.md`: the learner's preferences about how they are taught.

## How to teach it

Knowledge first, from the sources above, with the difficulty low so working memory goes to understanding. Then skills: retrieval practice, spacing, and a feedback loop as tight as you can make it, ideally automatic. Quiz answers have the same length, and the correct one moves around.

## Practice on a scratch project, never the real backlog

A lesson that runs `pup` runs it against a throwaway project, with `--project <id>`, so the learner's real backlog, branches and PRs stay out of it. `pup init` registers a project and is the operator's to run (a session is refused it): ask the operator to onboard a scratch repo, or to name the one they made for this. Use only commands the lesson is about: `pup status`, `pup plan`, `pup plan add`, `pup launch`, `pup steer`, `pup review`, `pup log`, then `pup merge --pr`, `pup ci wait`, `pup fix`, `pup land` and `pup audit`.

The gate and CI stages push a branch and open a pull request, so they need a scratch GitHub repository the learner owns. Without one, teach those stages from `skills/pup/LOOP.md` and the dossier of a task that already landed in this project (`pup log`, `pup report`), and say plainly that the learner has read the step and not run it. Never run `pup merge`, `pup land`, `pup debt close` or a kill against the real project as an exercise.

## Zone of proximal development

If the learner names what they want, teach it. Otherwise read the learning records, decide the next step from the mission, and teach the most relevant thing within reach. Write a learning record only on evidence: a correct use of the concept, prior knowledge they state, a misconception corrected, or a shift in the mission (confirm that with them first). Coverage is not learning.
