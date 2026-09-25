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
- **Twins and siblings were not represented** in these two corpora. Five
  identical-twin pairs were measured later ("Twins", below): this recogniser
  cannot tell them apart. Non-twin siblings are still unmeasured.
- **Glasses were not a variable here**; they were measured later ("Pose,
  eyes, expression and glasses", below).
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

## Classroom quality

A classroom face is never refused for quality. It is embedded and matched
like any other, and a quality flag caps whatever it matches at **needs
review**. So a flag should mean exactly one thing: *this face is outside the
conditions the thresholds above were validated on.* Inside those conditions
the calibrated score, both ambiguity margins and the one-to-one assignment
decide, and they are what keeps one student from being marked present as
another. Until 2026-09-25 the flags meant something broader.

### What was measured

Composed classroom photographs, built the way the product captures them:
1920×1080 frames, JPEG quality 0.82, faces from 40px to 200px, 98 enrolled
students and 148 strangers from the two corpora, each probe a different
photograph from its enrolment photograph — in Corpus A, years apart. Each
condition was applied to the face at its placed size, blur in recogniser
pixels so that a level costs the same at every size. 600 photographs, 10,172
enrolled-student placements, one live Azure Detect call per photograph, the
production chip and recogniser, and the decision rules of apps/web replayed
line for line. Every detected face was recorded, so any flag policy can be
replayed on the same faces.

**Detection was not the limit:** Azure found all 14,326 placed faces
(students and strangers) at every size and in every condition. What limited
recognition was the flags.

### What went wrong

Azure's `blur` rating responds to darkness and size, not only to focus (the
same bias found at enrolment, above); its `exposure` rating flags faces the
recogniser handles well. Share of detected faces flagged, and the students
recognised automatically:

| Condition | Azure "blurred" | Azure "too dark" | Present, production flags | Present, no flags at all |
| --- | --- | --- | --- | --- |
| clean | 20.1% | 4.1% | 56.5% | 71.4% |
| dark (×0.45) | **97.8%** | 20.1% | 1.9% | 67.8% |
| dark (×0.3) | **100%** | 75.0% | 0.0% | 60.8% |
| backlit | **97.5%** | 20.2% | 1.5% | 65.2% |
| half the face in shadow | 57.7% | 14.8% | 28.1% | 62.7% |
| bright (×1.45 + 30) | 12.2% | — (58.7% "too bright") | 19.7% | 58.6% |
| Gaussian blur 1px | 75.9% | 5.2% | 14.9% | 66.9% |
| JPEG quality 25 | 32.8% | 3.8% | 41.9% | 54.9% |

With **no flags at all**, across all 10,172 placements, not one student was
marked present as somebody else. The flags were removing automatic
recognition — to 21% overall — without removing any error, because there was
none left for them to remove.

"No flags" is not the answer either. It marked 27% of students present at
3px of blur and 16% at 12px of shake: correctly, in this test, but on faces
far outside anything the thresholds were chosen on.

### What is measured instead

`classroom_flags` in `app/models/azure_dlib_provider.py`:

| Flag | Now raised when | Before |
| --- | --- | --- |
| `blurred` | the enrolment blur measure (above), on the face, exceeds 0.72 — rising to 0.78 at 40px | Azure blur level `high` |
| `too_dark` | the face's mean brightness is under 25 **and** its contrast under 8 | Azure exposure `underExposure` |
| `too_bright` | more than 60% of the face is blown out (≥245) | Azure exposure `overExposure` |
| `occluded` | also when more than 10% of the face's core lies outside the photograph | Azure occlusion flags only |
| `face_too_small`, `bad_angle`, `occluded`, `low_quality` | unchanged: under 40px; yaw over 45°, pitch over 35°, roll over 45°; Azure's occlusion or mask; Azure's recognition quality `low` | same |

**Blur.** The identities were split in two by a fixed hash. On half A the
threshold was set at the 5th percentile of the measure over severely blurred
faces (Gaussian 2px or more, which costs a template over 0.011 of genuine
similarity, or 8px of shake or more):

| Face | 5th percentile, severe (half A) | Threshold |
| --- | --- | --- |
| 40px | 0.779 | 0.78 |
| 60px | 0.759 | 0.75 |
| 80px | 0.731 | 0.72 |
| 100px | 0.718 | 0.72 |
| 120px | 0.709 | 0.72 |
| 160px | 0.734 | 0.72 |
| 200px | 0.717 | 0.72 |

It rises below 80px because a face smaller than the recogniser's chip is
enlarged into it, and enlargement reads as blur. On half B — held out:

| Blur (half B, held out) | Flagged, 60–200px | Flagged, 40px |
| --- | --- | --- |
| none (clean, dark, bright, backlit, shadow, colour cast, JPEG 25–40) | 0.4% (10 of 2,244) | 11.8% |
| mild (Gaussian 0.5px) | 0.4% | 6.0% |
| moderate (Gaussian 1–1.5px, shake 3–5px) | 40.9% | 37.0% |
| severe (Gaussian 2–3px, shake 8–12px) | **97.6%** | **99.0%** |

Mild and moderate blur are left to the score, which falls with blur on its
own: a moderately blurred face that still scores above the present threshold,
unambiguously, is as safe as any other in this evaluation.

**Exposure.** The darkest validated condition (×0.3) left faces at a median
brightness of 41 (5th percentile 30) and contrast of 11 (5th percentile 7.7),
and they were recognised automatically 61% of the time with no error. The
dark flag sits beyond that: it caught 0.8% of those faces and nothing in any
other condition. The bright flag caught the most blown-out 6% of the
brightest condition and nothing else.

**Frame edge.** Azure clamps a face's rectangle to the photograph, so the
rectangle cannot tell a face that is cut off. It extrapolates the landmarks
past the edge, and they can: the canonical face's core is mapped back into
the photograph and the share of it outside is measured
(`face_core_outside`). dlib is given black for what is missing — nothing is
invented — and the match goes to review.

### The result

The same 10,172 placements, replayed with each policy:

| Condition | Present, production | **Present, now** | Present, no flags |
| --- | --- | --- | --- |
| clean | 56.5% | **65.1%** | 71.4% |
| dark (×0.45) | 1.9% | **62.4%** | 67.8% |
| dark (×0.3) | 0.0% | **56.1%** | 60.8% |
| backlit | 1.5% | **59.8%** | 65.2% |
| half the face in shadow | 28.1% | **58.6%** | 62.7% |
| bright | 19.7% | **51.1%** | 58.6% |
| warm / cool colour cast | 53.3% / 53.2% | **62.5% / 64.4%** | 69.8% / 69.8% |
| Gaussian blur 0.5 / 1.0px | 51.2% / 14.9% | **63.9% / 57.1%** | 70.8% / 66.9% |
| Gaussian blur 1.5 / 2.0 / 3.0px | 0% / 0% / 0% | **18.8% / 0.8% / 0%** | 56.6% / 50.3% / 27.3% |
| shake 3 / 5px | 24.7% / 3.2% | **50.4% / 25.0%** | 66.0% / 56.9% |
| shake 8 / 12px | 0.6% / 0.2% | **2.8% / 0.2%** | 41.5% / 15.9% |
| JPEG quality 40 / 25 | 47.2% / 41.9% | **57.5% / 52.8%** | 62.7% / 54.9% |
| **All conditions** | **21.0%** | **42.6%** | 57.7% |
| **Marked present as somebody else** | **0** | **0** | **0** |

By face size, clean photographs:

| Face | Production | **Now** |
| --- | --- | --- |
| 40px | 10.2% | **20.4%** |
| 60px | 56.1% | **70.4%** |
| 80px | 65.3% | **74.5%** |
| 100px | 67.3% | **75.5%** |
| 120px | 68.4% | **74.5%** |
| 160px | 88.5% | 88.5% |
| 200px | 80.8% | 80.8% |

The rest of each row went to review or, when the face scored below the
review floor against its years-old template, was not matched to anyone. That
last group — 867 of 10,172 — is the same under every policy: a flag can only
move a face between present and review. So is the number of faces sent to
review under the wrong name, 343: a teacher sees those, and no policy here
marks them present.

### Verified on live Azure, through the production code

Fresh composed photographs (a different random draw), each sent through
`analyze_image` — the code production runs, one live Detect call — and the
flags it returned fed to the same decision rules. Faces of 60, 100 and 160px:

| Condition | Present | Wrong student present | Flags raised |
| --- | --- | --- | --- |
| clean | 72 / 101 | **0** | occluded 2 (at the frame edge) |
| dark (×0.45) | 75 / 103 | **0** | occluded 1 |
| backlit | 66 / 93 | **0** | occluded 2 |
| Gaussian blur 1px | 57 / 100 | **0** | blurred 12, occluded 5, bad angle 2, low quality 2 |
| Gaussian blur 3px | 0 / 99 | **0** | blurred 120, occluded 3 |
| shake 8px | 4 / 101 | **0** | blurred 107, occluded 2, low quality 1 |

At the edge of the frame, 120 and 200px faces:

| Share of the face outside the photograph | Present | Wrong | Review | Not matched | `occluded` flags |
| --- | --- | --- | --- | --- | --- |
| 0% (touching the edge) | 11 / 18 | **0** | 6 | 1 | 0 |
| 20% | 5 / 18 | **0** | 12 | 1 | 12 |
| 45% | 0 / 18 | **0** | 8 | 10 | 16 |

A face touching the edge is treated as any other; a face a fifth outside is
usually sent to review, and at 45% no face was marked present. Five at 20%
were: no more than a tenth of each one's core was outside the photograph, so
they were not flagged, and their scores decided.

### What this does not establish

The composed photographs are the evaluation's limit. Every face in them is a
portrait pasted onto a plain background: no perspective, no neighbour's
shoulder over a chin, no uneven light *across* a room, one condition at a
time. Real classrooms combine them. The flags are measurements, not
guesses, so a real photograph outside the validated range will still be
flagged — but how often real classroom faces land there has not been
measured.

### Lighting normalisation: measured, not adopted

Whether normalising a face's lighting before embedding helps was measured on
the 98 identities with two photographs: the probe degraded, then embedded as
is or after normalising the aligned chip; the template untouched. Genuine
similarity (mean), and the change each normalisation makes to it:

| Probe | As is | CLAHE | Luminance stretch | Automatic gamma | Worst impostor, as is |
| --- | --- | --- | --- | --- | --- |
| clean | 0.9666 | −0.0048 | +0.0002 | −0.0001 | 0.9369 |
| dark (×0.3) | 0.9641 | −0.0004 | +0.0012 | −0.0008 | 0.9390 |
| very dark (×0.15) | 0.9586 | +0.0027 | +0.0028 | +0.0019 | 0.9375 |
| gamma 2.2 | 0.9648 | −0.0039 | −0.0017 | +0.0015 | 0.9432 |
| bright | 0.9605 | −0.0029 | −0.0020 | −0.0010 | 0.9391 |
| side shadow | 0.9658 | −0.0027 | +0.0003 | −0.0003 | 0.9376 |
| warm cast | 0.9662 | −0.0043 | −0.0002 | 0.0000 | 0.9374 |

dlib's descriptor is already robust to lighting: the darkest probe loses
0.008. Every normalisation helps somewhere and hurts somewhere else, and each
raised the worst impostor score in at least one condition (CLAHE under a warm
cast: 0.9374 → 0.9454, the largest). Rank-1 over all seven conditions was 677
of 686 as is, and no normalisation improved on it. **None was adopted.**

## Enrollment at institution scale

When a sample is enrolled, apps/web looks up the eight nearest templates in
the whole institution. A different student at or above the present threshold
(raw 0.955) refuses the sample as a duplicate. Until 2026-09-25, a different
student in the review band (raw 0.93 to 0.955) refused it too, as
"ambiguous".

The review band is a per-class threshold for one face against a few dozen
students. Applied institution-wide, it meets a pool that grows with every
enrolment. On the 346 photographs of 248 people above:

| Measure | Value |
| --- | --- |
| Pairs of photographs of different people | 59,587 |
| … at or above raw 0.93 (review band) | 57 (0.096%) |
| … at or above raw 0.955 (duplicate) | **0** |
| Highest | 0.9463 |
| Photographs with a *different* person at or above 0.93 | 64 of 346 (18.5%) |

At 0.096% a pair, a single enrolment photograph checked against an
institution enrolled at five samples a student meets at least one lookalike
with probability 1 − (1 − 0.00096)^(5N) — assuming pairs are independent, and
at this corpus's rate:

| Students | A photograph refused as "ambiguous" |
| --- | --- |
| 50 | 21% |
| 200 | 62% |
| 500 | 91% |
| 1,000 | 99% |

Refusing a lookalike protected nobody. A photograph of somebody *else who is
already enrolled* scores in the duplicate band (0 of 59,587 unrelated pairs
reach it) and is still
refused (79.6% of the 98 second photographs here do). What refusing a
lookalike did was leave the student with no template,
so they could never be recognised. Lookalikes are now enrolled; staff are
told whom the face resembles, and the audit row records it. The protection
against confusing two similar students is at attendance, where both are
visible: the two ambiguity margins, one-to-one assignment, the lookalike rule
below, and a teacher.

The duplicate refusal, the already-enrolled check and the own-sample
consistency check are unchanged.

## Twins

**This recogniser cannot tell identical twins apart.** Measured on every
usable single-person photograph of five identical-twin pairs of public
figures on Wikimedia Commons (public domain, CC0, CC BY, CC BY-SA),
photographs that appear under both twins removed. The pairs are called A to E
here; which pair is which is recorded with the evaluation data, outside this
repository, like the rest of the provenance.

| Pair | Photographs | Same twin, median | Other twin, median | Other twin at or above present (0.955) | … at or above review (0.93) |
| --- | --- | --- | --- | --- | --- |
| A | 8 + 31 | 0.936 | 0.930 | 10.1% | 49.2% |
| B | 11 + 17 | 0.956 | 0.934 | 8.6% | 63.1% |
| C | 13 + 6 | 0.931 | 0.935 | 10.3% | 64.1% |
| D | 5 + 3 | 0.948 | 0.949 | 46.7% | 80.0% |
| E | 6 + 6 | 0.904 | 0.837 | 2.8% | 5.6% |
| *60 unrelated classmates* | — | — | — | *0 of 1,770 pairs* | *0.11%* |

For four of the five pairs, a photograph of one twin is as close to the other
twin as to themselves. The fifth, E, is separated almost as strangers
are; their photographs span decades and their labels could not be checked by
eye, so that pair's results are the least reliable here.

### What protects them

With both twins enrolled, a classroom photograph of one can still score as a
confident, unambiguous match to the other — the margin between them is not
evidence of which one it is. So apps/web finds, from the enrolled templates
alone, the students it cannot tell apart, and never marks a match to either
of them present on the recogniser's word (`findLookalikeStudents`). A pair
is found when either:

1. a template of one is a confident match for the other (calibrated
   `presentMin`) — enrolling such a sample requires a member of staff to
   confirm they are different people; or
2. at least three comparisons between their templates reach `reviewMin`
   (`LOOKALIKE_REVIEW_BAND_MATCHES`): what an identical twin looks like to
   this recogniser, and what unrelated students were not seen to do.

Simulated classes — both twins plus 60 unrelated classmates, K random
photographs of each twin enrolled, every remaining photograph of either twin
a classroom face, 60 random enrolments per pair and K — wrong twin marked
present:

| Pair | K | No safeguard | Rule 1 only | **Rules 1 and 2** | Pair found by 1 and 2 |
| --- | --- | --- | --- | --- | --- |
| A | 1 | 5.9% | 5.2% | 5.2% | 8% |
| | 3 | 5.4% | 4.4% | **1.6%** | 87% |
| | 5 | 2.8% | 1.0% | **0.0%** | 100% |
| B | 1 | 2.8% | 2.6% | 2.6% | 5% |
| | 3 | 3.4% | 2.3% | **0.2%** | 95% |
| | 5 | 2.8% | 0.4% | **0.0%** | 100% |
| C | 1 | 5.7% | 4.8% | 4.8% | 10% |
| | 3 | 10.1% | 4.7% | **0.9%** | 97% |
| | 5 | 7.0% | 0.2% | **0.0%** | 100% |
| E | 5 | 4.2% | 4.2% | 4.2% | 68% |
| D | 1 | 23.1% | 21.4% | 21.4% | 40% |

The price is paid by the twins themselves: once found, neither is ever marked
present automatically (right twin present: 0% at K = 5 for the three pairs
above), and a teacher confirms them every day. That is the intended trade.

**What it costs everybody else.** Rule 2 was checked on unrelated people
with the same number of templates: 27 people with five or more event
photographs (351 pairs, 10 random five-template draws of each) and 29 with
three or more (406 pairs). **No unrelated pair met it** — in 0 of 3,510 and
0 of 4,060 draws; the closest came to 0.9285 against the rule's 0.93. That
is a loose bound, not a guarantee: with 351 distinct pairs it rules out only
a rate above about 0.9% a pair (95%), so a large class may occasionally hold
an unrelated pair that is flagged. Such a pair costs those two students
review, never a wrong record, and it shows in the run log's
`lookalikeStudents` count (docs/RUNBOOK_DEPLOYMENT.md). With 30 of these
people and 97 corpus classmates enrolled together, no unrelated student was
flagged by either rule and no correct match was lost.

A per-face rule was measured as well and not adopted: capping a match whose
runner-up scored in the review band when the two students' templates come
within 0.94 of each other. It helped only at one sample each (pair A: 5.2% →
4.1%), where no rule makes twins safe; with the templates at 0.93 instead, it
cost unrelated students 1.3 points of automatic recognition in the composed
classrooms (42.7% → 41.3%).

### What still goes wrong

- **Only one twin enrolled.** The other twin walks in and is marked present
  as their sibling: 21.8% (pair A), 18.7% (pair B), 12.8% (pair C), 51.2%
  (pair D) of their photographs. Nothing computed from templates can see
  a person who has none. **Both twins must be enrolled.**
- **One sample each.** One comparison cannot show a pattern; 2.6–5.2% of the
  twins' appearances were still marked present as the other. Enrolment asks
  for five, and tells staff so whenever it notices a resemblance.
- **Pairs like E** — twins this recogniser separates on most photographs
  but not all: 4.2% at five samples, unchanged by either rule.

## Pose, eyes, expression and glasses

Measured on 591 single-person photographs of 50 people from Commons event
series and candid categories (capture dates and events recorded, so the same
day and different days can be told apart), each photograph compared with the
same person's frontal photographs (|yaw| < 10°, |pitch| < 15°). Photographs with more than one
prominent face were not used; one file labelled with the wrong person was
found by a surprising result and excluded. Genuine similarity, and the share
able to be marked present (≥ 0.955) or below the review floor (< 0.93):

| Head turned (yaw) | Same day: median / ≥ 0.955 | Different day: median / ≥ 0.955 / < 0.93 | Photographs (different day) |
| --- | --- | --- | --- |
| 0–10° | 0.983 / 96% | 0.971 / 83% / 4% | 191 |
| 10–20° | 0.974 / 96% | 0.966 / 73% / 11% | 114 |
| 20–30° | 0.967 / 90% | 0.960 / 66% / 5% | 80 |
| 30–45° | 0.960 / 64% | 0.950 / 36% / 16% | 56 |
| over 45° | 0.921 / 20% | 0.928 / 0% / 63% | 16 |

A turned head costs little up to 30° and a great deal beyond 45°. It does
not make two people look alike: the best impostor score rises only from a
median of 0.909 to 0.919 at the widest angles, and no impostor reached 0.955
at any angle.

| Head tilted (pitch; different day, |yaw| < 20°) | Median | ≥ 0.955 | < 0.93 | n |
| --- | --- | --- | --- | --- |
| level (±15°) | 0.968 | 79% | 7% | 305 |
| looking up (> 15°) | 0.965 | 73% | 9% | 22 |
| **looking down (> 15°)** | 0.944 | 39% | 33% | 18 |

Azure's pitch sign was established from the landmarks (positive pitch moves
the nose tip towards the eyes: correlation −0.77 over 2,192 faces). Looking
down — at a desk, a phone — is the costly direction.

**Expression** (mouth, different day): closed 0.970 median (86% ≥ 0.955),
parted 0.969 (83%), open 0.967 (77%). A smile or speech costs little, and
the guided enrolment already asks for one.

**Eyes closed:** only two photographs of 591 had closed eyes (lid gap under
0.12 of the eye's width) and three had narrowed ones — too few to measure
anything. The alignment uses the eye *corners*, which a closed eye still has,
and no rule refuses or flags a closed eye; synthetic regression tests pin
that (`tests/test_azure_dlib_provider.py`, "Eyes closed"). How much a blink
costs a real match is not established here.

**Glasses** (Azure's own `glasses` attribute, requested only for this
evaluation):

| Two photographs of one person | Event series, different days | Portrait pairs, years apart |
| --- | --- | --- |
| both without glasses | 0.961 median, 10% below review (1,336 pairs) | 0.972, 0% (78) |
| both with | 0.970, 6% (16) | 0.968, 0% (12) |
| **glasses on one, not the other** | **0.929, 51% below review** (35 pairs, 6 people) | **0.939, 33%** (6) |

A change of glasses between enrolment and class costs recognition more than
anything above short of a 45° turn — and never made two people look the
same: different people who both wear glasses score higher (0.204% reach the
review band, against 0.090% when neither does), but none reached 0.955. So the
last guided enrolment step now asks anyone who wears glasses only some of the
time to take that photograph the other way.

**Time.** Two near-frontal photographs of one person: same day 0.975 median
(95% ≥ 0.955), under a year apart 0.964 (75%), one to three years 0.957
(53%), more than three 0.958 (56%; 13% below review). Appearance drifts; a
student who stops being recognised reliably needs new samples, and re-enrolment
replaces the set.

**Beard, hairstyle, hair over the face.** Not measured: Azure no longer
reports facial hair or hair, and nothing here labels them. The portrait pairs
years apart and the event series across years include such changes without
isolating them.

## Templates: how many, and how they are combined

30 people from the event series were enrolled from one event (the "enrolment
day"), and recognised on photographs from other days, alongside 97 corpus
classmates and 145 strangers who were not enrolled:

| Enrolment | Present | Review | Not matched | Wrong student present | Strangers present |
| --- | --- | --- | --- | --- | --- |
| one frontal photograph | 46.8% | 36.8% | 16.4% | 0 | 0 of 145 |
| frontal + slightly left + slightly right | 55.9% | 32.4% | 11.7% | 0 | 0 |
| **up to five, same day** (the guided set) | **59.9%** | 31.1% | **9.0%** | 0 | 0 |

The guided samples help most where they were meant to: with five, a head
turned 20–30° was marked present 67.7% of the time, against 35.5% with one
frontal photograph. Beyond 30° they help little (13.3%).

**How a student's templates are combined** — the best one (production), the
mean of the best two, a soft maximum, or the mean of all:

| Aggregation, five templates | Present | Wrong student present |
| --- | --- | --- |
| **best template (production)** | **59.9%** | 0 |
| mean of the best two | 54.2% | 0 |
| soft maximum | 52.2% | 0 |
| mean of all | 40.8% | 0 |

The best template wins, and none of the alternatives buys safety: none marked
a wrong student or a stranger present either. **Unchanged.**

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
  `bench/calibrate_enrollment_sharpness.py`;
- the classroom flags and their thresholds, in `classroom_flags` and the
  constants above it (`app/models/azure_dlib_provider.py`), and the
  frame-edge measure, `face_core_outside` (`app/models/face_sharpness.py`);
- the lookalike rule, in `findLookalikeStudents` and
  `LOOKALIKE_REVIEW_BAND_MATCHES`
  (`apps/web/src/modules/recognition-engine/service.ts`).

The classroom, twin, pose, glasses and template evaluations were run with
throwaway scripts against the same production code paths: composed classroom
photographs through `analyze_image` and live Azure, and single photographs
through the production chip and recogniser, with apps/web's decision rules
replayed in Python. They need the photographs, so they are not committed; the
numbers above are their output.

To recalibrate: measure on your own population, change the two middle knots,
change the calibration `id`, and expect to re-examine every result recorded
under the old one. The id is stored with results precisely so that is
possible.
