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

## Enrolment sharpness

Enrolment refuses a blurred photograph, because a template is compared every
day for a term and a blurred one costs the student every one of those days.
This section is about how "blurred" is decided, because until 2026-09-25 it
was decided wrongly.

### What went wrong

Enrolment accepted a face only if Azure rated its `blur` attribute `low`.
That rating turns out to track **how many pixels the face occupies**, not
whether it is in focus. Sharp portraits, merely resampled smaller (no blur
added), as rated by live Azure:

| Face width | Azure rated blur `low` | Median Azure blur value |
| --- | --- | --- |
| 96px | 37% | 0.47 |
| 64px | 0% | 0.44 |
| 48px | 0% | 0.63 |

It also rises for things that are not blur: a backlit face scored 0.74, a
dark one 0.52, heavy JPEG 0.57. Enrolment's size floor is 100px, so faces from
100px to about 200px — a webcam capture from a normal distance — passed the
size check and were then refused as "blurry", with the advice "hold the camera
steady". On live Azure, with real portraits prepared the way the browser
prepares a camera capture (JPEG quality 92):

| Capture | Refused as blurred |
| --- | --- |
| Sharp face, 120px | **28 of 60** |
| Sharp face, 180px | 4 of 60 |
| Sharp face, 260px | 0 of 60 |

Azure's `qualityForRecognition` does not share the bias — sharp 96px faces
were rated `high` 151 times out of 151 — and it still falls for real blur (a
1.2px blur at 64px: `medium` 249 times out of 251). It still has to be
`high` to enrol.

### What is measured instead

`app/models/face_sharpness.py`, on the decoded original — never the preview,
never the copy re-encoded for Azure:

1. The face is aligned into dlib's template frame from the same five points
   the recogniser uses, **after** being reduced to the recogniser's scale by
   area averaging. Measuring on dlib's own chip was tried first and rejected:
   its extraction samples from a power-of-two pyramid, and a Laplacian of the
   chip read 243, 769 and 227 at faces of 100, 200 and 256px — a measurement
   of the resampler.
2. Only an ellipse inside the face is measured, brows to mouth. A rectangle's
   lower corners reach past the jaw, and a busy background there moved the
   measure of one face by 0.06; inside the ellipse, 0.002.
3. The **blur effect** (Crete-Roffet et al., 2007): the share of the face's
   gradient that survives being blurred again. It is a ratio of the image
   with itself, so exposure and contrast cancel.
4. Over the strongest tenth of the gradients only — lids, brows, nostrils,
   lips. Over every pixel, skin smoothing (a phone's beauty mode; plausibly a
   child's face) was read as blur 17% of the time; over the strongest edges,
   4%.
5. In four directions, the worst of which decides. Along the two axes alone,
   an 8px diagonal shake was caught about 70% of the time, against 100%
   horizontally.

A face under 100px is refused as **too small** before blur is measured. A
small face has little detail at any focus, and "move closer" fixes both.

### What blur costs a template, and the threshold

The threshold is set by what blur costs recognition, not by how blur looks.
Each of the 101 enrolment photographs with a second photograph of the same
person was resized to a capture-sized face (100 to 400px), degraded at that
scale, JPEG-encoded and embedded; the loss of genuine similarity against the
untouched second photograph is the cost. Blur is given in recogniser pixels,
so a level means the same at every face size. 346 photographs in all were
measured (`bench/calibrate_enrollment_sharpness.py`).

| Condition | Mean cost (raw) | Refused at 0.65 |
| --- | --- | --- |
| clean, JPEG 92 / 75 / 50 | −0.0001 / −0.0002 / −0.0005 | 0.5% / 0.5% / 0.4% |
| dark (×0.45) / bright (×1.35) | −0.0011 / −0.0053 | 0.4% / 0.2% |
| skin smoothing | −0.0023 | 3.5% |
| Gaussian blur 0.75px | −0.0010 | 12% |
| Gaussian blur 1.0px | −0.0023 | 41% |
| Gaussian blur 1.25px | −0.0042 | 79% |
| **Gaussian blur 1.5px** | **−0.0065** | **96%** |
| Gaussian blur 2.0px / 3.0px | −0.0113 / −0.0208 | 100% / 100% |
| camera shake 5px / 8px, any direction | −0.0047 / −0.0119 | 80% / 99.5% |
| defocus 2.5px | −0.0054 | 89% |
| blur under sensor noise | −0.0095 | 96% |

The criterion was fixed before the number was read: **refuse 95% of captures
blurred by 1.5 recogniser pixels**, the first level that costs a template more
than 0.005 of genuine similarity — about 0.034 on the product's calibrated
scale, and 6.6 points of present-rate. That lands at 0.6525; the threshold is
**0.65**. Below 1.5px, blur is refused in proportion to what it costs, and
0.75px — a cost of 0.001 — is mostly accepted.

The decision does not move with face size:

| Face | Clean refused | Clean at JPEG 50 | Dark | Blur 1.5px refused | Blur 2.0px | Shake 8px |
| --- | --- | --- | --- | --- | --- | --- |
| 100px | 0.6% | 0.6% | 0.6% | 96.5% | 100% | 98.5% |
| 128px | 0.6% | 0.6% | 0.6% | 96.0% | 100% | 99.7% |
| 160px | 0.7% | 0.7% | 0.7% | 95.7% | 100% | 99.7% |
| 200px | 0.7% | 0.4% | 0.4% | 95.6% | 100% | 100% |
| 256px | 0% | 0% | 0% | 95.1% | 100% | 100% |
| 400px | 0% | 0% | 0% | 97.4% | 100% | 99.1% |

Every clean capture refused came from **two** source photographs, refused
alike at every size. One Azure also rates blurred (0.45 at full resolution);
the other, inspected by eye, is a heavily noise-reduced photograph with no
crisp edge on the face. On the rest, nothing clean was refused.

A blurred enrolment template does not drift towards other students — at 3px
of blur the highest impostor score was 0.937 against 0.937 unblurred, and none
reached the present knot. The harm is to the student: their genuine score
falls (median 0.970 sharp, 0.959 at 2px), and they are sent to review.

### Verified on live Azure, through the production code

Real portraits, prepared as the browser prepares a capture, one live Detect
call each; old and new decisions taken from the same Azure response:

| Capture | Old gate accepted | New gate accepted |
| --- | --- | --- |
| sharp, 120px | 32 / 60 | **60 / 60** |
| sharp, 180px | 56 / 60 | **60 / 60** |
| sharp, 260px | 60 / 60 | 60 / 60 |
| blurred 2px, 180px | 0 / 60 | **0 / 60** |
| shaken 8px at 40°, 180px | 0 / 60 | **0 / 60** |

### What this does not establish

Everything in "What this does NOT establish" above applies here too — adult
portraits only, no children, no real classroom or webcam captures. Two things
specific to this measure:

- **Children.** A child's skin is smoother than an adult's. Measuring over the
  strongest edges was chosen partly for this, and simulated skin smoothing is
  refused 3.5% of the time — but no child's photograph has been measured.
- **Real camera softness is simulated.** Webcam optics, noise reduction and
  focus hunting were approximated by Gaussian, motion and disc blurs, sensor
  noise and bilateral smoothing. The line every refusal writes to the logs
  (`enrolment quality: …`, docs/RUNBOOK_DEPLOYMENT.md) exists so that real
  captures can be checked against this table.

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
- the enrolment blur measure and its threshold, in
  `app/models/face_sharpness.py`, and the sweep that calibrates it, in
  `bench/calibrate_enrollment_sharpness.py`.

To recalibrate: measure on your own population, change the two middle knots,
change the calibration `id`, and expect to re-examine every result recorded
under the old one. The id is stored with results precisely so that is
possible.
