# Thresholds, and the measurements they came from

The product's thresholds are 0.62 to mark a student present and 0.45 to send a
face to a teacher. Those numbers are institution policy and they are not
changing. What this document establishes is what they *mean* for the
recogniser production runs, because a raw similarity from dlib's ResNet is not
on the same scale: **most pairs of different people score above 0.85**, and
0.94 — which would sail past 0.62 read naively — is two different people.

So the service publishes a measured map from its raw scale onto the product's,
apps/web applies it before any threshold sees a score, and this document is
the evidence for the two numbers that map is pinned to.

| Raw | Calibrated | Meaning |
| --- | --- | --- |
| 0.930 | 0.45 | review floor: below this, not a match at all |
| 0.955 | 0.62 | present: above this, and unambiguous, and unflagged |

Calibration id `dlib-resnet-v1.azure-d03.2026-09-24`. It is reported on
`/v1/model-info` and recorded with every run, so a later recalibration is
visible in the audit trail rather than silently rewriting history.

> **These thresholds are provisional.** They were measured on public-domain
> adult portraits, not on classroom photographs from a school using this
> product. Everything below says exactly what was and was not tested. An
> institution deploying this should expect to re-measure against its own
> population before trusting the present threshold unattended.

---

## What was measured, and on what

Two independent evaluations, both on publicly licensed photographs of public
figures. **No student's photograph was used, and no image from this product's
database was used.**

| | Corpus A (general) | Corpus B (South Asian) |
| --- | --- | --- |
| Images | 212 | 142 |
| Identities with two photographs | 61 | 40 |
| Additional single portraits (strangers) | 90 | 62 |
| Purpose | Does the scale separate at all? | Does it separate *within one population*? |

Corpus B exists because Corpus A's impostor pairs are mostly people who look
nothing alike, and a classroom in India is not that. Every impostor comparison
in Corpus B is between two South Asian adults — the case this product actually
faces. It is the harder and more relevant number, and it is the one the
thresholds were set from.

Image licences across both corpora: CC BY-SA, CC BY, CC0 and public domain.
Provenance for each file is recorded alongside the corpus, outside this
repository; no photograph is committed here.

## The separation

**Corpus A, clean:**

| Measure | Value |
| --- | --- |
| Genuine minimum (lowest score between two photographs of one person) | 0.9491 |
| Impostor maximum (highest score between two different people) | 0.9463 |
| Rank-1 identification | 61 / 61 |
| Smallest margin between the right person and the runner-up | 0.028 |

A gap, but a narrow one: 0.0028 between the worst genuine pair and the best
impostor pair. That gap is the entire basis for any automatic decision, which
is why the review band below it is wide.

**Corpus B, clean** — the numbers the thresholds are actually set from:

| Measure | Value |
| --- | --- |
| Genuine minimum | 0.9032 |
| Genuine median | 0.9563 |
| Genuine 5th percentile | 0.9308 |
| Impostor maximum | 0.9453 |
| Impostors at or above the review knot (0.93) | 11 |
| Impostors at or above the present knot (0.955) | **0** |
| Rank-1 identification | 40 / 40 |
| Smallest genuine margin over the runner-up | 0.0002 |

Read that last row next to the raw ambiguity margin of 0.01: there exists a
genuine pair whose correct match beat the wrong one by two ten-thousandths.
That is why a raw margin is enforced *as well as* the institution's calibrated
one. A face whose top two candidates are within 0.01 raw goes to a teacher
regardless of how far apart their calibrated scores land.

**Enrolment-side separation** (how close two different enrolled people get):

| Comparison | Maximum | p99 | Median |
| --- | --- | --- | --- |
| Corpus B enrolment vs Corpus B enrolment | 0.9214 | 0.9180 | 0.8564 |
| Corpus B enrolment vs Corpus A enrolment | 0.9339 | — | — |

Both sit below the 0.955 present knot, which is what makes the duplicate and
collision checks at enrolment usable rather than a source of constant false
refusals.

## Degradation: what a real classroom does to this

Corpus B was re-run with each probe degraded to simulate a back row and poor
conditions. `w64` means the face was resampled to 64 pixels wide before
detection; `backlit` is a strong exposure skew; `blur1.2` is a Gaussian blur.

| Condition | Impostor max | Rank-1 | Present | Review | Unknown | Wrongly present |
| --- | --- | --- | --- | --- | --- | --- |
| clean | 0.9453 | 40/40 | 22 | 16 | 2 | **0** |
| w64 | 0.9375 | 40/40 | 14 | 23 | 3 | **0** |
| w64 + backlit | 0.9440 | 40/40 | 7 | 31 | 2 | **0** |
| w48 | 0.9360 | 40/40 | 7 | 29 | 4 | **0** |
| w64 + blur 1.2 | 0.9327 | 38/40 | 0 | 29 | 10 | **0** |
| w36 | 0.9331 | 38/40 | 0 | 33 | 7 | **0** |

And for the 62 strangers — people not enrolled at all — across every
condition: **0 were marked present**, 7 reached review at worst, 55 were
correctly unknown.

The shape of this table is the point. As conditions worsen the system does not
start guessing; it stops claiming. At 36 pixels nothing is auto-marked present
at all, and one probe in twenty is reported as unknown rather than attributed
to the wrong student. That is the intended failure direction: a teacher
confirming thirty-three faces is an inconvenience, and one student marked
present in another's name is not.

One caveat in that table is worth stating plainly: at w36 the smallest genuine
margin is **-0.0077** — negative, meaning the wrong person outscored the right
one for at least one probe. It did not become an attendance record because it
was below the present knot and inside the ambiguity margin. It is exactly the
case the review band exists for, and it is why the small-face floor
(`MIN_EMBEDDABLE_FACE_PX = 32`) sits above Azure's own 36-pixel detection
limit rather than at it.

## Occlusion

From Corpus A, with parts of the face masked:

| Condition | Rank-1 | Wrongly present |
| --- | --- | --- |
| Mouth occluded | 57 / 61 | 0 |
| Eyes occluded | 56 / 61 | 0 |

Eye occlusion costs more than mouth occlusion, which is what the alignment
would predict: the chip is positioned from the eye corners.

## The alignment offset, and why it was measured

dlib's recogniser expects a chip aligned on *its* five points: four eye
corners and the base of the nose. Azure supplies the eye corners directly. It
has no point at the base of the nose, so the fifth point is derived from the
midpoint of the two nostril out-tips, shifted by a fixed offset measured in
inter-eye distances.

The offset was measured as the median displacement between dlib's own nose
point and Azure's alar midpoint across 151 portraits, then checked on 61
held-out ones:

| Method | Median nose error (inter-eye distances) |
| --- | --- |
| Raw alar midpoint, no offset | 0.1611 |
| With the measured offset | **0.0315** |

A fivefold reduction. It is applied in the face's own frame — along and across
the eye line — so it follows a rolled head instead of sliding off the nose
(`test_the_offset_follows_the_face_when_the_head_is_rolled`).

---

## What this does NOT establish

Every item here is a real limitation, not a formality.

- **No children.** Both corpora are adults. Error rates for children, and for
  a child photographed a year later, are unmeasured. This product is deployed
  in schools.
- **No classroom photographs.** Every probe is a portrait, degraded
  synthetically. Real classroom capture adds motion blur, mixed lighting
  within one frame, heads turned towards a speaker, and occlusion by other
  students — combined, not one at a time.
- **Demographic skew inside Corpus B.** The men are mostly Bangladeshi, Sri
  Lankan and Nepali; the women are mostly Indian and Pakistani; **there are no
  Pakistani men at all.** Any per-group error rate from this corpus would be
  computed on a handful of people and should not be quoted.
- **Six of the 62 stranger portraits have uncertain identity** — they are
  labelled from their source page, which could be wrong. They are strangers,
  so a mislabel cannot create a false genuine pair, but it slightly
  understates the impostor set.
- **Four probes are very small** (66, 74, 76 and 82 pixels wide). They are in
  the clean set, which makes "clean" marginally pessimistic.
- **Twins and siblings are not represented.** The near-collision case the
  ambiguity margin exists for has never been measured on an actual pair.
- **No measurement of glasses as a variable**, only whatever the corpus
  happened to contain.
- **Sample size.** 40 genuine pairs cannot establish a false-accept rate at
  the scale a school needs. "0 wrongly present out of 4,040 impostor
  comparisons" bounds the rate loosely; it does not measure it.

## Measured again, through the production path

The evaluation above sent Azure the original image bytes. Production does not:
it re-encodes every image as JPEG first, to strip EXIF (GPS, device identity)
and to remove any chance that Azure and OpenCV disagree about orientation.
That changes the landmarks slightly, which changes the descriptors slightly,
and "slightly" is not an argument when a 0.0097 gap separates the worst
impostor from the present threshold.

So Corpus B was run a second time, end to end through the provider the service
actually runs — 142 live Azure Detect calls, re-encoded payloads, the same
statistics.

| Measure | Original bytes | **Production path** |
| --- | --- | --- |
| Faces detected | 40/40 probes, 62/62 singles | 40/40, 62/62 |
| Genuine minimum | 0.9032 | 0.9021 |
| Genuine 5th percentile | 0.9308 | 0.9330 |
| Genuine median | 0.9563 | 0.9562 |
| Impostor maximum (4,040 comparisons) | 0.9453 | 0.9456 |
| Impostors ≥ review knot (0.93) | 11 | 13 |
| **Impostors ≥ present knot (0.955)** | **0** | **0** |
| Rank-1 | 40/40 | 39/40 |
| Smallest genuine margin | +0.0002 | −0.0030 |
| Enrolment vs enrolment, maximum | 0.9214 | 0.9285 |

**Every decision is identical.** 22 present and correct, 16 to review and
correct, 2 unknown; 0 wrongly present, 0 wrongly reviewed; and of the 62
strangers, 0 present, 7 to review, 55 correctly unknown. The same numbers, on
both paths.

The two rows that moved are worth reading carefully, because they are the
honest cost of re-encoding:

- **Rank-1 went from 40/40 to 39/40.** One probe's highest raw score now
  belongs to the wrong person. That probe is one of the two classified
  **UNKNOWN** — its score is below the review knot, so nothing was attributed
  to anybody. The ranking changed; the outcome did not.
- **The smallest genuine margin went negative** (−0.0030), which is the same
  event stated as a distance. It is inside the 0.01 raw ambiguity margin, so
  even had the score been high enough to matter, the face would have gone to a
  teacher rather than been marked automatically.

A descriptor-level check on 20 of the same portraits puts the shift at cosine
0.9988 to 0.9999 (median 0.9995) between the two paths, with face boxes moving
at most one pixel. That is the mechanism behind the table above.

**Conclusion:** the calibration measured on original bytes holds for the
production path. The property the thresholds exist to guarantee — nobody is
marked present as somebody else — is preserved with the same margin, and the
one ranking change lands below the review floor, which is where an uncertain
face is supposed to land.

## Reproducing this

The evaluation scripts and corpora live outside this repository (they contain
photographs). What is committed here is what production depends on:

- the knots, in `app/models/azure_dlib_provider.py` (`DLIB_CALIBRATION`);
- the arithmetic, in `app/matching.py` and
  `apps/web/src/modules/recognition-engine/calibration.ts`, with a test that
  asserts both produce identical floating-point values at 23 points including
  every knot;
- the alignment offset and the golden self-test values, in
  `app/models/dlib_recognition.py`.

To recalibrate: measure on your own population, change the two middle knots,
change the calibration `id`, and expect to re-examine every result recorded
under the old one. The id is stored with results precisely so that is
possible.
