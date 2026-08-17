# Incident-review skill (template)

A causal-review gate for high-severity incidents that makes the register part
of the investigation loop. Adapt the tool names to your harness; keep the
ordering — recall before hypothesis is the point.

---

## Protocol (in order — do not skip)

1. **Recall first.** Run `lessons_query` on the incident domain and likely
   failure modes BEFORE forming a hypothesis. Record which lessons were
   retrieved and which were applied (`lessons_apply`). Diagnosis before recall
   is a gate failure.

2. **Separate narrative from evidence.** Two explicit buckets: (a) claims and
   story, (b) raw artifacts — logs, diagnostics, filesystem state, timestamps,
   command output. Only bucket (b) can support a causal edge.

3. **Build the evidence matrix.** Decompose the root cause into causal edges
   (A → B). Label every edge `observed` (direct artifact proof), `inferred`
   (plausible, unproven), or `unproven` (assumed). A chain is only as strong
   as its weakest labeled edge.

4. **Deterministic checks on every load-bearing edge:** temporal (is the
   evidence timestamped inside the incident window?), attribution (which
   exact process produced it?), sink (what actually grew/changed?), magnitude
   (throughput is not net growth — prove the net change), arithmetic
   (re-derive every rate and total; compare against a normal-baseline period).

5. **Competing hypotheses.** Enumerate at least two alternatives; for each,
   name the single piece of evidence that would disprove it, then go look.

6. **Cold independent pass.** A fresh session (different model if possible)
   receives the raw artifacts and the questions only — never the author's
   conclusion — and returns its own verdict and matrix.

7. **Closure rule.** `ACCEPT` only when process + sink + temporal ordering +
   magnitude all reconcile. Anything less is `ROOT CAUSE UNCONFIRMED`, said
   plainly. Do not build remediation on an `inferred` edge — frame it as
   hardening, not "the fix".

8. **File the lesson.** The durable lesson from the incident goes through
   `lessons_candidate` for curation. Preserve superseded conclusions —
   mark withdrawn verdicts, never delete them.
