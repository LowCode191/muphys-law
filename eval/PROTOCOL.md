# Evaluating a lessons register honestly

Most agent-memory projects ship retrieval and never measure whether it changes
anything. This document is the evaluation protocol we ran against muphys-law
before releasing it, so you can (a) audit our claims and (b) rerun it against
your own fleet. The headline results live in the README; this is the method.

## The funnel

A lessons system fails at whichever link breaks first:

```
capture → curate → retrieve → deliver → apply → outcome
```

Instrument every link (this package logs queries, injections, applications,
and outcomes for exactly this reason) and evaluate them separately. A good
lesson that never gets retrieved, a retrieval that never gets delivered, and
a delivery that never changes behavior are three different defects with three
different fixes.

## Track A1 — retrieval quality (cheap, offline, run it first)

Build a golden set of (task wording → relevant lesson id) pairs from real
incidents. For each retriever you care about (the built-in lexical scorer,
BM25, embeddings, hybrid), measure top-1 / top-5 / MRR under both
near-verbatim wording and meaning-preserving paraphrases. Paraphrase recall
is where lexical scorers die; measure it, don't assume it.

## Track A2 — behavioral trial (does delivery change behavior?)

Design: **N scenarios × 2 arms × 2+ seeds**, fresh isolated session per run,
grader blind to arm.

- Each scenario encodes one real failure class with a **specific guard** —
  the concrete thing a competent answer does (checks the right layer, names
  the right mechanism, refuses with the right reason). Write "what a 2 looks
  like" per scenario before any run.
- **Treat arm:** the scenario's lesson injected in the hook's exact block
  format. **Control arm:** identical prompt, no injection.
- Rubric anchors: **0** commits the failure class · **1** generic caution
  without the specific guard · **2** applies the guard. A well-written answer
  that misses the guard is a 0 or 1 — grade the guard, not the prose.
- **Blinding:** export transcripts, strip injection blocks, rename to random
  ids. Grade all cells, lock the grades to a file, only then open the
  unblind map. Report the 0/1/2 **distribution** per arm, not just means.
- **Safety:** delegation- or mutation-shaped scenarios carry a hold ("report
  the exact call you would make; do not execute"); destructive scenarios
  target disposable fixture directories created per run.

## Traps we hit so you don't

1. **Arm-tell leakage.** A treated agent citing its injected lesson's id is
   simultaneously your strongest mechanism evidence and an unblinding tell.
   Decide the policy up front (we recommend: strip ids from the *blind
   copies* rather than discarding the runs — discarding biases the effect
   downward) and verify the guard actually catches every format the ids
   appear in. Ours missed five files; we disclosed it.
2. **Ceiling effect / saturated control.** If your agents' standing context
   already carries the lessons, both arms max out and the trial measures
   nothing. Expect the effect to concentrate in scenarios whose lesson exists
   *only* in the register — and read that as the finding it is: injection
   matters exactly where knowledge isn't already ambient.
3. **Transcript integrity.** Validate every artifact before grading: exactly
   one user turn, ≥1 assistant turn, no injection residue, unique blind ids,
   arms and seeds balanced. Runner races that export a user turn with no
   response read as failures and corrupt the delta.
4. **Never hand-transcribe the provenance table.** Generate every
   blind-id → cell mapping programmatically and re-verify the final document
   against the map. (Our first hand-built appendix had 22 transposition
   errors across 48 rows. The check caught it.)
5. **Artifacts on disk are the source of truth** — not your job ledger, not
   your task tracker, not the runner's exit code.
6. **Verify hooks by effect.** Before trusting any treated run, prove the
   injection path fires from a *real* harness-spawned session by watching the
   injection log — not by reading settings files back. (See README §
   Mounting.)

## Reading the result

- Paired design, exact stats: sign test / McNemar on discordant cells;
  report the p-value plainly even when it's unflattering.
- With small n, report per-scenario deltas and seed disagreement next to the
  aggregate. If seed variance rivals the arm delta, say so — it caps the
  verdict's weight.
- Separate the claims the data licenses ("mechanism works, no harm observed")
  from the ones it doesn't ("improves agents by X%"). Put only the former in
  your README.
