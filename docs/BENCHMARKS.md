# Benchmarks — performance and recognition

Measured 2026-09-17 on an Apple Silicon laptop (darwin arm64), Node v26.0.0,
Python 3.11, Chrome 152.0.7977.84.

Everything in this document is a number produced by running code in this
repository. Where a number could not be produced, the section says so and
says why, rather than estimating. Reproduction commands are in [§8](#8-reproducing-these-numbers).

> **This system has not been benchmarked for recognition accuracy, and
> cannot be until it has a licensed model and a consented dataset.** What has
> been benchmarked is everything around the model: the decision policy, the
> candidate search, the service latency floor and the frontend. Read
> [§1](#1-what-was-measured-and-what-was-not) before quoting anything here.

---

## 1. What was measured, and what was not

| Question | Status | Where |
| --- | --- | --- |
| How fast is the class-scoped candidate search? | **Measured** | [§3](#3-class-specific-search) |
| Is PostgreSQL/pgvector sufficient? | **Measured + answered** | [§4](#4-database) |
| Do 2 or 3 images beat 1? | **Measured** (synthetic geometry) | [§5](#5-multi-image-1-vs-2-vs-3) |
| What thresholds should ship? | **Measured, recommendation not applied** | [§6](#6-thresholds-and-acceptance-criteria) |
| Frontend page performance, network, mobile | **Measured** (public routes only) | [§7](#7-frontend) |
| Face detection rate on real photographs | **Not measured — blocked** | [§2](#2-the-model-and-why-accuracy-is-unmeasured) |
| Recognition accuracy / FAR / FRR on real faces | **Not measured — blocked** | [§2](#2-the-model-and-why-accuracy-is-unmeasured) |
| Attendance processing state timing end-to-end | **Not measured — blocked** | [§7](#7-frontend) |

### The synthetic-geometry method, stated plainly

Sections 5 and 6 drive the **real shipped decision code** —
`scoreFaceAgainstCandidates`, `classifyBySimilarity`, `aggregateByStudent` —
over **synthetic embedding vectors**. No detector, no alignment, no pixels.

The generative model is in `apps/web/scripts/bench/synthetic.ts` and is worth
one paragraph here because everything downstream depends on it. Each student
gets a uniformly random unit vector in R^512. (The synthetic benchmark's own
space; the production contract moved to 128-d in Phase 5 and these runs predate
it.) Two such vectors have cosine
~ N(0, 0.044), so the *impostor* distribution is not a parameter — it falls
out of the geometry of the space. A photograph of a student is constructed at
an exactly controlled cosine to their identity vector, drawn from N(mu, sd)
for a named **quality regime** and reduced by a per-condition penalty.

`mu` is the stand-in for "how good is the model", and it is never assumed:
every result is reported across four regimes bracketing the range that
published ArcFace-family models occupy, so a reader can find the row matching
whatever a real model eventually measures.

**What this proves:** how the policy behaves on a given embedding geometry —
which thresholds are safe, whether aggregation helps, where review load goes.

**What this does not prove:** anything about a face model. The per-condition
penalties (angle, lighting, glasses, obstruction, distance) are a declared
*ordering* with plausible magnitudes, not measurements. They are the weakest
assumption in this document and they are the first thing a real dataset
replaces.

---

## 2. The model, and why accuracy is unmeasured

### Exact version under test

Reported by `GET /v1/model-info` on the service these benchmarks ran against:

```json
{
  "modelName": "mock",
  "modelVersion": "0.1.0+pp1",
  "weightsVersion": "0.1.0",
  "preprocessingVersion": "1",
  "embeddingDim": 512,   // historical: this run predates the Phase 5
                         // move to SFace's native 128-d width
  "embeddingNormalized": true,
  "runtime": "numpy-hash-stub",
  "commercialUse": "not-applicable",
  "productionEligible": false,
  "contractVersion": "v1"
}
```

The `mock` backend derives a deterministic vector from a hash of the image
bytes. It is not a face model and does not attempt to be one. Two photographs
of the same person hash differently, so **running the accuracy harness
against it yields ~100% false rejection by construction** — a fact the
harness's own README has recorded since it was written.

### Licensing

From `services/face-ai/app/models/LICENSING.md`:

| Component | Licence | Commercial use |
| --- | --- | --- |
| InsightFace **source code** | MIT | Permitted |
| InsightFace **pretrained models / training data** (`buffalo_l`, `antelopev2`) | Non-commercial research only | **Not permitted** |
| ONNX Runtime | MIT | Permitted |
| `mock` backend (this repo) | — | Not applicable; not a model |

No backend in this repository is cleared for production. `MODEL_REGISTRY` in
`app/config.py` carries a `commercial_use` field per backend, and
`FACE_AI_REQUIRE_PRODUCTION_MODEL=true` makes the service refuse to start on
an uncleared one. A test asserts that no shipped backend claims
`"permitted"`. Licence enquiries go to `recognition-oss-pack@insightface.ai`.

### The two blockers, stated without hedging

1. **No licensed model.** Detection rate, recognition accuracy, and
   real-image FAR/FRR cannot be measured. Substituting an uncleared model to
   produce a number would be both a licence violation and a measurement of
   something that cannot ship.
2. **No dataset.** The brief calls for "authorized test subjects". There are
   none in this repository and creating a face dataset is not something to
   improvise — it needs consent, a retention decision, and a lawful basis.
   `services/face-ai/bench/README.md` specifies the manifest format for when
   one exists; `bench/manifest.py` now requires cohorts at **10, 20, 50 and
   100** (100 added in this phase).

No claim is made here that this system makes "zero mistakes". Its
false-acceptance rate on real faces is **unknown**.

---

## 3. Class-specific search

### The architectural fact that shapes the answer

`findCandidateEmbeddingsWithVectorsForCohort`
(`apps/web/src/modules/recognition-results/repository.ts`) loads the ACTIVE
templates of students enrolled in **one cohort** and scores them in-process.
It deliberately does not use pgvector's `<=>` operator or any
nearest-neighbour ordering — the query's own comment says so.

So the candidate pool on the hot path is **the class size**. Not the
institution. Not 5,000. Search is class-scoped by construction, enforced by
the `INNER JOIN "Enrollment" … AND en."cohortId" = $1 AND en.status = 'ACTIVE'`
in the query, not by a filter someone could forget to apply.

500 and 5,000 are measured below as **stress points** — "what would this cost
if the scope were ever widened" — not as configurations that exist.

### TypeScript path (`apps/web`), the one production uses

30 faces per image, each scored against the whole pool.

| Pool | Parse pool (p50) | Parse (p95) | 1 face scan (p50) | Per image, 30 faces (p50) | Per image (p95) | Wire (text) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 1.04 ms | 1.13 ms | 0.015 ms | 0.44 ms | 0.48 ms | 525 KB |
| 100 | 2.09 ms | 2.15 ms | 0.029 ms | 0.86 ms | 0.89 ms | 1.03 MB |
| 500 | 10.31 ms | 10.80 ms | 0.147 ms | 4.34 ms | 4.45 ms | 5.13 MB |
| 5000 | 102.89 ms | 109.35 ms | 1.520 ms | 44.55 ms | 44.93 ms | 51.29 MB |

Both costs are linear in pool size, as expected from a `for` loop over an
array. The notable result is the **ratio**: parsing the pgvector text literal
costs roughly 2.3× the entire 30-face scan over the same pool. The scan is
not the expensive part; getting the vectors into JavaScript is.

At the pool size that actually occurs — 50 to 100 students — the whole
in-process recognition arithmetic for a three-image capture is **under 5 ms**.

### Python path (`services/face-ai`)

`score_candidates` in `app/matching.py`, in-process, no HTTP:

| Candidates | mean | p95 | per candidate |
| ---: | ---: | ---: | ---: |
| 10 | 0.14 ms | 0.15 ms | 14.3 µs |
| 20 | 0.34 ms | 0.39 ms | 16.9 µs |
| 50 | 0.87 ms | 0.96 ms | 17.4 µs |
| 100 | 1.68 ms | 1.93 ms | 16.8 µs |
| 500 | 7.32 ms | 8.00 ms | 14.6 µs |
| 2000 | 29.67 ms | 34.99 ms | 14.8 µs |
| 5000 | 73.79 ms | 82.79 ms | 14.8 µs | *(exceeds the HTTP cap — in-process only)* |

**The Python scan is ~50× slower per candidate than the TypeScript one**
(≈15 µs vs ≈0.30 µs). `cosine_similarity` re-runs `np.asarray` and both
norms on every call, so a 512-float dot product is dominated by per-call
NumPy overhead.

This is a real inefficiency and it is **not on the hot path**: production
scores in `apps/web`, and `/v1/match` exists for callers who want the service
to do it. It is recorded here so that if that ever changes, the fix
(vectorise the pool into one `(n, 512)` matrix and take a single matmul) is
already identified. Per the brief — *optimize only after measuring* — nothing
was changed, because nothing measured is slow where it matters.

`face_ai_max_match_candidates` caps a `/v1/match` request at 2,000
candidates. That cap is itself a restatement of "search must remain
class-scoped", and it is why the 5,000 row above is in-process only.

### Service latency (HTTP, real requests)

Against a running service, `mock` backend, 15 iterations after warm-up.

`POST /v1/detect-embed` — the request a faculty member waits on, with
1600×1200 JPEGs:

| Images | Request body | mean | p95 |
| ---: | ---: | ---: | ---: |
| 1 | 949 KB | 3.09 ms | 3.49 ms |
| 2 | 1.85 MB | 5.15 ms | 5.31 ms |
| 3 | 2.78 MB | 7.60 ms | 7.83 ms |

`POST /v1/match` at the cohort sizes the brief names:

| Cohort | Request body | mean | p95 |
| ---: | ---: | ---: | ---: |
| 10 | 314 KB | 3.25 ms | 3.03 ms |
| 20 | 424 KB | 4.76 ms | 4.81 ms |
| 50 | 755 KB | 10.22 ms | 10.28 ms |
| 100 | 1.31 MB | 19.90 ms | 20.09 ms |

**These are floors, not totals.** With the `mock` backend the per-face
compute is a hash, so the figures measure serialisation, validation,
transfer and scan — the overhead a real model's inference time is *added to*.
A real ArcFace-family model on CPU is on the order of tens of milliseconds
per face; a 30-face classroom image would dominate everything in the table
above. Quoting these as recognition latency would be wrong.

Note what the `/v1/match` body sizes show: at cohort 100, **1.31 MB** of
which the overwhelming majority is candidate embeddings shipped over HTTP to
get scores back. That is precisely the cost the in-process design in
`apps/web` avoids, and it is why `recognition-engine/service.ts` duplicates
the cosine implementation rather than calling `/v1/match`.

---

## 4. Database

**Verdict: PostgreSQL with pgvector is sufficient. No separate vector
database is warranted, and none was introduced.**

The reasoning is not primarily about speed, it is about what the hot path
actually does:

1. **The ANN index is not on the hot path at all.** The recognition query
   deliberately avoids `<=>`. It filters by cohort enrollment and returns the
   exact candidate set; ranking happens in-process so that every score in a
   run comes from one cosine implementation. A vector database's entire value
   proposition — approximate nearest neighbour over a large corpus — is
   something this system has decided not to use.
2. **The pool is a class, not a corpus.** 50–100 vectors. Specialised vector
   stores start paying for themselves at 10^6 and up. At 10^2 the index would
   be slower than the scan.
3. **The measured cost is trivial and is dominated by text parsing.** 1.04 ms
   to parse 50 templates, 0.44 ms to score a 30-face image against them. A
   different database does not change either number, because neither is a
   database operation.

If the candidate load ever does become a bottleneck, the measurements point
at two fixes ahead of "adopt a vector database", both already contemplated by
the repository comment:

- Stop round-tripping through `embedding::text`. The parse is 2.3× the scan;
  a binary representation removes most of it.
- Use `<=>` as a **pre-filter** inside the cohort, then re-score the survivors
  exactly. The repository comment already notes this can be done without
  changing wire behaviour.

Neither was implemented. Nothing measured is slow enough to justify it, and
the brief is explicit: do not prematurely optimize.

**Not measured:** query planning, index usage, and connection behaviour under
concurrency. This environment has no pgvector-capable Postgres — Docker is
not installed and building pgvector from source is out of scope — so
everything in this section that concerns the database is reasoning from the
query text plus measurements of the in-process work on either side of it. The
`EXPLAIN` evidence is missing and is listed in [§9](#9-gaps).

---

## 5. Multi-image: 1 vs 2 vs 3

### Why this could have gone either way

`aggregateByStudent` keeps, per student, the single **highest** similarity
that student attracted across every face in every image. Adding an image can
only raise a student's best score; it can never lower it. A max over more
samples moves both ways at once: a present student gets more chances to be
seen well, and an absent student gets more chances for a stranger's face to
score spuriously high against their template.

So "3 images is better" is a trade, not a fact. Here is which side wins.

### Results — `strong` regime, 40 trials per cell

| Cohort | Images | Capture | Correct PRESENT | FAR | FRR | Review load | Gates dissolved |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 1 | 76.4% | 42.7% | 0.00% | 23.9% | 27.5% | 0 |
| 10 | 2 | 94.5% | 66.4% | 0.00% | 5.8% | 23.0% | 90 |
| 10 | 3 | 98.8% | 82.4% | 0.00% | 1.2% | 13.5% | 165 |
| 50 | 1 | 76.1% | 41.9% | 0.00% | 25.3% | 28.1% | 0 |
| 50 | 2 | 93.5% | 65.7% | 0.00% | 7.3% | 23.2% | 477 |
| 50 | 3 | 98.7% | 81.2% | 0.00% | 1.5% | 14.9% | 884 |
| 100 | 1 | 75.8% | 42.4% | 0.00% | 25.8% | 27.2% | 0 |
| 100 | 2 | 93.5% | 66.0% | 0.00% | 7.2% | 22.8% | 897 |
| 100 | 3 | 98.5% | 80.6% | 0.00% | 2.0% | 14.9% | 1730 |

Full grid including the `excellent` regime and cohort 20:
`apps/web/scripts/bench/results/results.json`.

### The counter-example: when the third image makes things worse

The brief says not to assume 3 images is always better. It is not. Same code,
same cohort of 50, weaker embedding quality:

| Regime | Images | Correct PRESENT | FRR | **Review load** |
| --- | ---: | ---: | ---: | ---: |
| `weak` | 1 | 2.3% | 79.0% | **16.1%** |
| `weak` | 2 | 3.6% | 63.4% | **28.4%** |
| `weak` | 3 | 5.6% | 49.7% | **38.5%** |
| `moderate` | 1 | 11.2% | 48.4% | **34.3%** |
| `moderate` | 2 | 20.5% | 23.0% | **47.9%** |
| `moderate` | 3 | 28.4% | 11.4% | **51.0%** |

In the `strong` regime the extra images *reduced* review load, 28% → 23% →
15%, because the added evidence was good enough to resolve cases outright. In
the `weak` regime the same extra images **more than double** it, 16% → 28% →
38%, while correct recognition barely moves from 2% to 6%. Same code, same
capture count, opposite effect on the people who have to work the queue.

The mechanism is not subtle. Extra images raise every student's best score.
When scores are good, a raised score crosses `presentMin` and resolves. When
scores are poor, a raised score only crosses `reviewMin` — lifting students
out of a silent ABSENT and into the review queue without ever reaching a
decision. **With a weak model, additional images mostly convert absences into
homework for a human.**

That is not an argument against capturing three images — a case that lands in
review is being handled honestly, and a silent wrong ABSENT is worse. It is
an argument that "how many images" cannot be answered without knowing the
model's quality, and that **review capacity, not accuracy, is the binding
constraint if the model is weak**. Whichever model is eventually licensed
must be placed on this scale before the image count is treated as settled.

### Findings

**1. The second image is the one that matters. The third has clearly
diminishing returns.** At cohort 50, false rejection goes 25.3% → 7.3% →
1.5%. The first additional image removes 71% of the failures; the second
removes 79% of what was left but only 5.8 percentage points in absolute
terms. If capture time were ever a constraint, **2 images buys most of the
benefit of 3**.

**2. The benefit is a framing effect, not a recognition effect.** Capture
rate — the share of present students appearing in at least one usable frame —
goes 76% → 94% → 99%. Extra images help mostly because one photograph misses
a quarter of the room, not because averaging improves the match. This matters
for what to tell a user: "take the second photo from a different angle" is
better advice than "take more photos".

**3. Class size does not affect accuracy.** 10, 20, 50 and 100 produce
materially identical rates. The class-scoped pool keeps the impostor
population small and 512-dimensional geometry keeps random templates far
apart, so growing the class does not crowd the decision. This is direct
support for the class-scoping design.

**4. More images dissolve review gates.** This is the most important finding
in this document, and the second way — after review load — in which more
images is not simply better.

The ambiguity margin demotes a MATCHED face to UNCERTAIN when the runner-up
is within `ambiguityMargin` (0.05). But `aggregateByStudent` only carries
that demotion forward if the *winning* face was the ambiguous one. An
ambiguous 0.80 in image 1 followed by a clean 0.82 in image 3 aggregates to a
confident PRESENT, and the caution that fired on image 1 is gone.

The "gates dissolved" column counts exactly this: students where some face
raised an ambiguity flag and the aggregate still came out confidently
MATCHED. It is **0 at one image by construction, and it rises steeply** —
1,730 occurrences at cohort 100 across 40 trials of 100 students, i.e. it
touches on the order of 40% of student-instances.

Whether that is correct behaviour is a genuine product question, not a bug
with an obvious fix. The argument for it: the best observation should win,
and an ambiguous glimpse should not veto a clear one. The argument against
it: the system's stated invariant is that uncertainty is never silently
converted into a confident PRESENT, and across images that is arguably what
max-pooling does.

**No change was made.** Altering aggregation would change existing
recognition behaviour, which this phase's invariant forbids. It is recorded
here, and in the doc comment on `aggregateByStudent`'s benchmark, as a
decision for a human. The options, if it is ever taken up, are: carry any
face-level ambiguity forward to the aggregate; or require the winning face to
clear the ambiguity margin against the runner-up *across all images*.

**5. Zero false acceptances across the whole main grid** (0 in 48 cells).
That is a real result, but read [§6](#6-thresholds-and-acceptance-criteria)
before taking comfort from it — it is conditional on who is in the room.

---

## 6. Thresholds and acceptance criteria

### A correction to this benchmark's own first run

The first version of the multi-image benchmark gave every student an
independent random unit vector and reported **0.00% false acceptance in all
48 cells**, with the threshold sweep declaring all 42 operating points
"clean" and therefore recommending the *lowest* threshold on the grid.

Both results were artefacts. Independent unit vectors in R^512 have cosine
~ N(0, 0.044); the largest of 50 such draws is around 0.11. It was not
*possible* for an impostor to reach a 0.62 threshold, so the benchmark could
not observe the failure it exists to observe, and a benchmark that cannot
fail cannot tune anything.

Real cohorts are not independent draws — one age band, often one uniform,
sometimes siblings. Two mechanisms were added:

- **Enrolled look-alike pairs**, at a swept template similarity.
- **Unenrolled look-alikes**: persistent stranger identities, a third of them
  built to resemble an *absent* enrolled student.

### Why enrolled look-alikes turn out to be safe

Cohort 50, `strong`, sweeping enrolled-pair template similarity. "Opportunities"
counts occasions where a look-alike could have been mistaken for their pair.

| Pair similarity | Images | Look-alike false accepts | Routed to review | **Total false accepts** |
| ---: | ---: | ---: | ---: | ---: |
| 0.50 | 1 / 2 / 3 | 0 / 0 / 0 | 1.2% / 1.2% / 1.2% | 0 / 0 / 0 |
| 0.70 | 1 / 2 / 3 | 0 / 0 / 0 | 4.9% / 6.2% / 6.2% | 0 / 0 / 0 |
| 0.85 | 1 / 2 / 3 | 1 / 1 / 1 | 7.4% / 7.4% / 7.4% | **4 / 8 / 14** |
| 0.95 | 1 / 2 / 3 | 0 / 0 / 0 | 8.6% / 9.9% / 9.9% | **12 / 24 / 32** |

Across the entire sweep — 81 opportunities per cell, up to twin-level
similarity — enrolled look-alikes produced **at most 1 false acceptance**.

The reason is structural and worth recording: a look-alike who is enrolled is
almost always the **runner-up**, because the genuine student's own face
out-scores them against their own template. And the runner-up position is
exactly where the ambiguity margin is waiting. Routing to review rose
monotonically with similarity (1.2% → 9.9%), which is the system doing what
it was designed to do.

**The ambiguity margin is the control that protects against look-alike
students.** That was a design intention; it is now a measured one.

### But look at the last column

Total false acceptance in those same runs goes **4 → 8 → 14** at pair
similarity 0.85 and **12 → 24 → 32** at 0.95, as images go 1 → 2 → 3.

Those are not the enrolled pairs. They are the unenrolled strangers, who in
this sweep are also built at the swept similarity — and they scale with
image count almost linearly. This is the second half of the max-pooling
trade, measured: *the same mechanism that lets a present student be found
also gives an impostor more chances to clear the bar.* It does not appear in
the main grid in [§5](#5-multi-image-1-vs-2-vs-3) only because that grid
holds look-alike similarity at 0.5, where no impostor gets close.

So the honest statement of the multi-image result is narrower than "3 images
is better": **3 images is better when the population contains no convincing
unenrolled look-alikes. When it does, more images buy recall at the cost of
precision, and the threshold is what has to absorb the difference.**

### Where false acceptance actually comes from

An **unenrolled** look-alike. Someone in frame who resembles an enrolled
student and has no template of their own in the pool — so there is no genuine
competitor to out-score them, no close runner-up, and nothing for the
ambiguity margin to catch. They go straight to a confident PRESENT for a
student who is not in the room.

With that modelled, the sweep has teeth: **20 of 42 operating points remain
clean, 22 produce at least one false acceptance.**

### Sweep results

Cohort 50, 3 images, 42 operating points, pooled across all four quality
regimes — so the correct-present column is deliberately pessimistic: it
includes the `weak` regime, which no deployable model should resemble. Read
the columns against each other, not in absolute terms.

False acceptance depends only on `presentMin`; review load and false
rejection depend on both. One row per `presentMin`, at the `reviewMin` that
minimises review load among that row's clean-est options:

| presentMin | False accepts | FAR | Correct PRESENT |
| ---: | ---: | ---: | ---: |
| 0.50 | 22 | 3.026% | 76.2% |
| 0.55 | 13 | 1.788% | 66.8% |
| 0.60 | 2 | 0.275% | 56.9% |
| **0.62 (shipped default)** | **2** | **0.275%** | 52.6% |
| 0.65 | 1 | 0.138% | 46.2% |
| **0.70** | **0** | **0.000%** | 34.6% |
| 0.75 | 0 | 0.000% | 21.8% |
| 0.80 | 0 | 0.000% | 10.3% |
| 0.85 | 0 | 0.000% | 3.1% |

The highest `presentMin` at which any false acceptance occurred is **0.65**.
Every point at 0.70 and above was clean: **20 of 42 points clean, 22 with at
least one false acceptance.**

What `reviewMin` buys, at presentMin 0.70:

| reviewMin | FRR | Review load |
| ---: | ---: | ---: |
| 0.35 | 5.5% | 52.6% |
| 0.45 | 16.1% | 42.8% |
| 0.50 | 23.8% | 35.9% |
| 0.55 | 33.2% | 27.7% |

There is no free lunch in that table: every point of false rejection removed
is roughly a point added to the review queue. `reviewMin` does not decide who
is recognised, only whether a failure is silent (marked absent) or visible
(sent to a human). Lower is safer and more expensive.

### Recommendation, and why it was not applied

Applying the brief's stated criterion — *no high-confidence false match* —
and then minimising review load among the survivors gives:

> **presentMin 0.70, reviewMin 0.55.**

**The shipped default is presentMin 0.62, and it was not changed.** Two
honest reasons:

1. **The brief's own invariant forbids it.** Changing a confidence threshold
   changes recognition behaviour on every existing capture. "Do NOT change or
   break any existing functionality, logic, UI, database schema, or
   workflows" and "final thresholds must be based on benchmark results" pull
   in opposite directions here. Flagging the conflict is more useful than
   silently resolving it.
2. **The evidence is synthetic.** The recommendation is conditional on a
   modelled unenrolled-look-alike rate (3 strangers per class, a third of
   them resembling an absent student at 0.70 template similarity) that is a
   property of the test, not a measurement of any school. A real threshold
   needs a real dataset.

Thresholds are already per-institution configuration resolved through
`resolveConfidenceThresholds` from `Institution.settings`, so 0.62 is a
fallback rather than a hardcoded policy. An institution that wants the
conservative operating point can set it today without a code change.

It should be recorded plainly that **0.62 sits below the level at which this
benchmark stops producing false acceptances**, and that the cost of moving to
0.70 is steep: false rejection rises to 33% and roughly a quarter of the
class lands in the review queue. That trade is an institution's to make.

### Measurable acceptance criteria

Derived from the results above. These are the conditions a **real** benchmark
run must satisfy before this system is used for anything that matters.

| # | Criterion | Threshold | Status |
| --- | --- | --- | --- |
| AC-1 | Zero high-confidence false matches on the benchmark dataset | 0 advisory PRESENT for an absent student | **Cannot be evaluated** — needs a real dataset |
| AC-2 | Every uncertain case routed to human review | 100% of UNCERTAIN reach the review queue; finalization blocked while unresolved | **Met** — enforced in code and unit-tested |
| AC-3 | Face detection rate on benchmark captures | ≥ 95% of visible faces detected | **Cannot be evaluated** — needs a model |
| AC-4 | In-process scoring time, class-scoped | p95 < 50 ms for 3 images × 30 faces × 100 candidates | **Met** — measured ≈4.8 ms (2.15 ms parse once + 3 × 0.89 ms scan) |
| AC-5 | Service overhead for a 3-image capture | p95 < 100 ms excluding model inference | **Met** — measured 7.83 ms |
| AC-6 | Review load at the operating threshold | ≤ 20% of the class | **Conditionally met** — 14.9% at 0.62/`strong`; 27.7% at the recommended 0.70/0.55 |
| AC-7 | Recognition quality independent of class size | No degradation from 10 to 100 students | **Met** (synthetic) — rates within 1.5 pp |
| AC-8 | Mobile first-contentful paint on a throttled phone | < 2.5 s | **Met** — measured 0.67 s on public routes |
| AC-9 | Licensed, commercially cleared model in use | `productionEligible: true` | **Not met** — no cleared model exists |

AC-1, AC-3 and AC-9 are the ones that gate deployment, and all three are
blocked on the same two things: a licence and a dataset.

---

## 7. Frontend

Measured over the Chrome DevTools Protocol against a production build
(`next build` + `next start`), 5 cold runs per route per profile. Each run
gets its **own browser context** so it has its own HTTP cache partition — the
first version of this script shared a cache between runs and reported ~10 KB
transfers, which was a cache-hit benchmark wearing a performance benchmark's
clothes.

The `chrome-devtools` MCP could not be used: it owns one profile directory
and a Chrome was already holding it. Rather than close the user's browser,
`scripts/bench/frontend.mjs` speaks CDP to a separate instance launched with
its own `--user-data-dir`. Node 26 has a global `WebSocket`, so this needed
no new dependency.

**Desktop** (no throttling, 1440×900):

| Route | TTFB | FCP | LCP p50 | LCP p95 | Requests | Wire | JS (gz) | Decoded |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/` | 1.5 ms | 28 ms | 28 ms | 40 ms | 12 | 198.4 KB | 134.8 KB | 539.2 KB |
| `/login` | 2.8 ms | 20 ms | 20 ms | 48 ms | 13 | 201.5 KB | 136.3 KB | 543.5 KB |
| `/offline` | 1.6 ms | 24 ms | 24 ms | 28 ms | 14 | 213.1 KB | 148.4 KB | 587.8 KB |
| `/unauthorized` | 1.8 ms | 24 ms | 24 ms | 36 ms | 14 | 202.8 KB | 138.7 KB | 550.8 KB |

**Mobile** (4× CPU throttle, 1.6 Mbps / 150 ms RTT, 390×844 @3x):

| Route | TTFB | FCP | LCP p50 | LCP p95 | Requests | Wire | JS (gz) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/` | 1.6 ms | 672 ms | 672 ms | 676 ms | 12 | 198.4 KB | 134.8 KB |
| `/login` | 3.7 ms | 644 ms | 644 ms | 648 ms | 13 | 201.5 KB | 136.3 KB |
| `/offline` | 1.7 ms | 668 ms | 668 ms | 688 ms | 14 | 213.1 KB | 148.4 KB |
| `/unauthorized` | 1.5 ms | 672 ms | 672 ms | 676 ms | 14 | 202.9 KB | 138.7 KB |

Cumulative layout shift was 0 on every route except `/offline`, which shifts
0.0013 on desktop and 0.0055 on mobile — two orders of magnitude inside the
0.1 "good" threshold, and consistent with the offline banner laying out after
first paint. Not worth acting on; recorded so "CLS was zero" is not claimed
where it was not.

`servedFromCache` was 0 for all 8 rows, which is the check that the
per-run browser context did its job: every byte in the table crossed the
socket.

**Reading these numbers.** Mobile LCP of ~0.67 s is comfortably inside the
2.5 s "good" band, and the ~200 KB wire / ~135 KB gzipped JS is the shared
framework runtime and client bundle that **every** route pays, including the
dashboard ones that could not be loaded. So this is a genuine floor for the
whole application, not just for the four pages measured.

**What could not be measured, and why.** Every route under `/dashboard` and
`/portal` requires a session, and a session requires a seeded database.
There is no pgvector-capable Postgres here (Docker absent; source build out
of scope), so the following remain unmeasured:

- **Attendance processing state** — the capture → process → review
  transition, including how long the progress state is held and whether the
  SSE stream updates promptly. This is the single most important frontend
  measurement the brief asks for and it is the one blocked hardest.
- Per-route bundle cost for dashboard pages beyond the shared baseline.
- Network usage of a real capture upload (though [§3](#3-class-specific-search)
  measures the request bodies: 2.78 MB for three 1600×1200 images, which is
  the dominant cost of a capture and is worth attention on mobile data —
  client-side downscaling before upload is an obvious lever nobody has
  needed to pull yet).
- Real-device mobile performance; the mobile column is emulation.

---

## 8. Reproducing these numbers

```bash
# apps/web: search scaling, multi-image, look-alikes, threshold sweep
cd apps/web
node --import ./scripts/register-test-loader.mjs scripts/bench/run.ts
# -> scripts/bench/results/{results.json,report.md}

# face-ai: candidate scan + HTTP latency
cd services/face-ai
FACE_AI_AUTH_TOKEN=... FACE_AI_REQUIRE_AUTH=true \
  .venv/bin/python -m uvicorn app.main:app --port 8099 &
.venv/bin/python -m bench.perf --http http://127.0.0.1:8099 --token ... --out bench/results
# -> bench/results/perf.json

# frontend: CDP against a production build
npm run build --workspace=web
cd apps/web && npx next start -p 3100 &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --remote-debugging-port=9333 --user-data-dir=/tmp/bench-chrome-profile \
  --no-first-run --no-default-browser-check &
node scripts/bench/frontend.mjs --base http://127.0.0.1:3100 --cdp http://127.0.0.1:9333
# -> scripts/bench/results/frontend.json
```

The apps/web run needs the environment variables `src/lib/env.ts` validates
at module load (`DATABASE_URL`, `AUTH_SECRET`, `API_KEY_PEPPER`,
`FACE_AI_SERVICE_URL`). It never opens a database connection — the values
only have to parse.

Accuracy benchmarking against a real dataset is a different harness:
`services/face-ai/bench/README.md`.

---

## 9. Gaps

Things this document does not establish, collected in one place so they are
not inferred from silence.

1. **Recognition accuracy on real faces is unknown.** No licensed model, no
   consented dataset. Detection rate, real FAR and real FRR are unmeasured.
   No claim of correctness is made.
2. **The per-condition penalties are assumptions.** The angle / lighting /
   glasses / obstruction / distance magnitudes in `synthetic.ts` are a
   plausible ordering, not measurements. Every accuracy-shaped number in §5
   inherits this.
3. **The recommended threshold is conditional on a modelled adversary.** The
   unenrolled-look-alike rate is a property of the test.
4. **No database was involved.** No `EXPLAIN`, no index verification, no
   concurrency behaviour. §4's verdict rests on the query text plus
   in-process measurements, not on a query plan.
5. **Dashboard and portal frontend performance is unmeasured**, including the
   attendance processing state.
6. **Latency figures are floors.** The `mock` backend does no real inference.
7. **Single machine, single run.** One laptop, no cold-start effects, no
   concurrent load, no network beyond loopback.
8. **The Python `score_candidates` inefficiency is documented, not fixed** —
   deliberately, since it is not on the hot path.
9. **The review-gate dissolution in `aggregateByStudent` is documented, not
   fixed** — deliberately, since changing it would change shipped behaviour.
