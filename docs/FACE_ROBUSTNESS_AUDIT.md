# Face pipeline robustness audit

What the face pipeline did before the 2026-09-25 robustness work (production
commit `4b4cc38`), what was measured, what changed, and what still needs a
teacher. Every number here was measured through this repository's production
code paths — the same decode, the same Azure Face detection call, the same
chip and recogniser, apps/web's decision rules replayed line for line — not
taken from a paper or a model card.

> **Read this first.** The evaluation photographs are public-domain and
> Creative Commons photographs of adults, most of them public figures, and
> classroom scenes composed from them. There is no child, no real classroom
> photograph and no student's data in any of it. The results describe how the
> pipeline behaves on that material; they are not a promise about any
> particular school. Section 8 lists what was not measured at all.

The detailed evidence is in
[`services/face-ai/docs/CALIBRATION.md`](../services/face-ai/docs/CALIBRATION.md);
this document is the overview.

---

## 1. In short

- **Nobody was marked present as somebody else** in any measurement of
  unrelated people: 10,172 classroom placements under every quality policy,
  591 single-person photographs under every enrolment protocol and template
  aggregation, 145 unenrolled strangers. The one apparent exception traced to
  a mislabelled evaluation photograph, which the recogniser had matched
  correctly.
- **The biggest loss was self-inflicted.** Azure's blur and exposure ratings
  flagged dark, backlit and small faces the recogniser handled correctly, and
  every flag sends a match to review. Replaced by measurements of the face
  itself: automatic recognition in the composed classrooms went from **21.0%
  to 42.6%**, still with no wrong match.
- **Identical twins could be marked present as each other.** Now a pair the
  recogniser cannot tell apart is found from its own templates and sent to
  review; with five samples each, the wrong-twin rate fell to **0.0%** for
  three of the four pairs measured at that size. With one sample each, or
  with only one twin enrolled, it cannot be prevented.
- **Lookalikes are enrolled, not refused.** The enrolment check applied a
  per-class threshold to the whole institution and would have refused most
  new students' photographs at a few hundred students.
- **A change of glasses and a downward look** are the largest remaining costs
  after extreme head turns. The guided enrolment now asks for one photograph
  the other way on glasses.
- No threshold was lowered. No model, library, artefact or runtime download
  was added. The detection-only posture is unchanged.

## 2. The pipeline before

### Enrolment (one photograph at a time)

| Stage | What runs | Where |
| --- | --- | --- |
| Capture | Camera: up to 1280px long edge, JPEG quality 0.92. Upload: the file as chosen | Browser |
| Bounds | Base64 length and alphabet; JPEG/PNG/WebP magic bytes (`lib/image-validation.ts`); 8 MiB ceiling in face-ai | apps/web, face-ai |
| Decode | OpenCV, EXIF orientation applied | face-ai |
| Re-encode for Azure | The decoded pixels as JPEG (quality 95 first) — never the uploaded bytes, so EXIF and GPS never leave | face-ai |
| Detect | Azure `detection_03`, 27 landmarks, quality attributes, `returnFaceId=false` | Azure |
| Quality gate | One face; ≥ 100px; yaw ≤ 30°, pitch ≤ 25°, roll ≤ 30°; exposure; occlusion; Azure recognition quality `high`; blur measured on the face (≤ 0.65) | face-ai |
| Align | dlib's 5-point similarity transform from Azure's eye corners and nostrils (150×150 chip, padding 0.25) | face-ai |
| Embed | dlib ResNet v1, 128-d, L2-normalised | face-ai |
| Checks | Institution-wide nearest templates: duplicate (≥ presentMin) **and lookalike (≥ reviewMin) refused**; already enrolled; own-sample consistency | apps/web |
| Store | `FaceEmbedding` with model, preprocessing and alignment versions; up to 5 per student | Postgres |

### Classroom (up to three photographs)

| Stage | What runs | Where |
| --- | --- | --- |
| Capture | ≤ 1920px long edge, JPEG 0.82, camera only | Browser |
| Detect | Same call, one per photograph | Azure |
| Per face | Under 32px reported `face_too_small`; align; embed in batches of 16 | face-ai |
| Quality flags | `GROUP_PROFILE`: under 40px; yaw > 45°, pitch > 35°, roll > 45°; **Azure exposure level; Azure blur level `high`**; Azure occlusion or mask; Azure recognition quality `low` | face-ai |
| Candidates | The class's (or subject's) active templates of the running model version | Postgres |
| Score | Cosine per template; best template per student; calibrated to the product's scale | apps/web |
| Decide | Present ≥ 0.62, review ≥ 0.45 (calibrated); ambiguous if the runner-up is within 0.05 calibrated or 0.01 raw | apps/web |
| Assign | Greedy one-to-one per photograph ([FACE_ASSIGNMENT.md](FACE_ASSIGNMENT.md)) | apps/web |
| Cap | Any flag, reassignment or contested student → review | apps/web |
| Merge | Best observation per student across the photographs; demotions survive | apps/web |

### The parts

| Part | Identity |
| --- | --- |
| Detector | Azure AI Face `detection_03`: Microsoft's newest detection model, documented as improved on small, side-view and rotated faces |
| Landmarks | Azure's 27; five used — four eye corners, and the base of the nose from the nostril out-tips plus a measured offset |
| Alignment | dlib template, 150×150; alignment version `1.detection_03` |
| Recogniser | `dlib_face_recognition_resnet_model_v1`, weights `dlib-models-2a61575`, SHA-256 `55533b28…`; public domain |
| Normalisation | L2 unit length; no illumination normalisation (4.5) |
| Similarity | Cosine |
| Calibration | `dlib-resnet-v1.azure-d03.2026-09-24`: raw 0.93 → 0.45, raw 0.955 → 0.62, raw ambiguity margin 0.01 |
| Model version | `dlib-models-2a61575+pp1+al1.detection_03` — **unchanged**, so no template needs re-enrolling |

## 3. What was measured, and on what

| Set | Contents | Licences |
| --- | --- | --- |
| Portrait corpora A and B | 346 photographs of 248 people; 98 with two photographs, often years apart; B is all South Asian | Public domain, CC0, CC BY, CC BY-SA |
| Composed classrooms | 600 frames, 1920×1080 at JPEG 0.82, faces 40–200px, 98 enrolled + 148 strangers, 19 conditions — 10,172 enrolled-student placements, live Azure | derived from the above |
| Event series and candid photographs | 591 single-person photographs of 50 people, with capture dates and events; South Asian adults deliberately over-represented in the selection | Public domain, CC0, CC BY, CC BY-SA, GODL-India |
| Identical twins | Five pairs of public figures, A to E; 3–31 usable photographs of each twin | as above |

No photograph is in this repository. Evaluation scripts ran against the
production modules and a Python mirror of apps/web's decision rules, checked
against the web engine's own test vectors.

## 4. Findings and changes, condition by condition

### 4.1 Detection

Azure found **all 14,326 faces placed in the composed classrooms**, at every
size from 40px to 200px and in every lighting, blur, compression and colour
condition. Microsoft documents a 36px minimum face in frames up to
1920×1080 — exactly the product's capture — so a tiled or multi-pass
detection would only add Azure calls. It was not built. No detector change.

### 4.2 Classroom quality flags — the largest change

Azure's `blur` rating flagged 98–100% of faces that had only been darkened
and 76% of faces with 1px of blur; its exposure rating flagged 20–75% of dark
faces. With those deciding, 0–2% of dark or backlit students were recognised
automatically. With **no flags at all**, 0 of 10,172 placements were marked
present as somebody else: the flags were costing recognition and preventing
no error.

Flags now measure the face (`classroom_flags`): severe blur on the
recogniser's scale (threshold at the 5th percentile of severely blurred faces
on half the identities; on the other half it flags 97.6% of severe blur, 41%
of moderate and 0.4% of none, from 60px up); darkness and blow-out beyond any
validated condition; and a face more than a tenth cut off by the frame edge.
Size, pose, occlusion and Azure's recognition-quality rating are unchanged.

| Condition | Present, before | **Present, now** | Wrong student present |
| --- | --- | --- | --- |
| clean | 56.5% | **65.1%** | 0 |
| dark ×0.45 / ×0.3 | 1.9% / 0.0% | **62.4% / 56.1%** | 0 |
| backlit | 1.5% | **59.8%** | 0 |
| half the face in shadow | 28.1% | **58.6%** | 0 |
| bright | 19.7% | **51.1%** | 0 |
| warm / cool colour cast | 53.3% / 53.2% | **62.5% / 64.4%** | 0 |
| Gaussian blur 0.5 / 1.0 / 1.5px | 51.2% / 14.9% / 0% | **63.9% / 57.1% / 18.8%** | 0 |
| Gaussian blur 2 / 3px | 0% / 0% | 0.8% / 0% — flagged | 0 |
| shake 3 / 5 / 8 / 12px | 24.7 / 3.2 / 0.6 / 0.2% | **50.4 / 25.0** / 2.8 / 0.2% | 0 |
| JPEG quality 40 / 25 | 47.2% / 41.9% | **57.5% / 52.8%** | 0 |
| **All** | **21.0%** | **42.6%** | **0** |

Verified again on fresh photographs through `analyze_image` and live Azure:
clean 72/101, dark 75/103, backlit 66/93 present; 3px blur 0/99 and 8px
shake 4/101 (flagged); 0 wrong.

### 4.3 Small faces

Clean photographs, present before → now: 40px 10.2% → 20.4%, 60px 56.1% →
70.4%, 80px 65.3% → 74.5%, 100px 67.3% → 75.5%, 120px 68.4% → 74.5%, 160px
88.5%, 200px 80.8% (unchanged). No face was enlarged, sharpened or restored;
a 40px face is still mostly sent to review, because at that size the evidence
is thin.

### 4.4 Edge of the frame

Azure clamps a cut-off face's rectangle to the photograph but extrapolates
its landmarks past the edge. The share of the face's core outside the
photograph is now measured; over a tenth is flagged, and dlib is given black
for what is missing — nothing is invented. Live: touching the edge, 11/18
present; 20% outside, 5/18 present and 12 flagged; 45% outside, 0/18 present;
0 wrong.

### 4.5 Lighting

dlib is robust to lighting on its own: the darkest probe (×0.15) loses 0.008
of genuine similarity. CLAHE, a luminance stretch and automatic gamma were
each measured on 98 identities under seven conditions; each helped somewhere,
hurt somewhere else, and raised the worst impostor score in at least one
condition. **No normalisation adopted.** Dark and backlit faces now reach the
recogniser unflagged (4.2), which is where the lighting gain came from.

### 4.6 Blur and camera shake

Mild blur is left to the score, moderate blur lowers it by itself, severe blur
is flagged (4.2). Present: mild (0.5px) 64%; moderate (1–1.5px, 3–5px shake)
19–57%; severe (2px or more, 8px of shake or more) 0–3%. The enrolment blur
gate (0.65, set on 2026-09-25) is unchanged.

### 4.7 Head pose

Genuine similarity against frontal photographs of another day: 0–10° 0.971
(83% could be marked present), 10–20° 0.966 (73%), 20–30° 0.960 (66%),
30–45° 0.950 (36%), beyond 45° 0.928 (0%). A turned head never made two
people look alike: no impostor reached 0.955 at any angle. **Looking down**
more than 15° is the costly tilt (0.944, 39%; looking up: 0.965, 73%) —
students looking at desks will often be sent to review. The guided enrolment
roughly doubles automatic recognition at 20–30° (35.5% with one frontal
photograph, 67.7% with the guided five); beyond 30° it helps little. Extreme
profiles that Azure does not detect are not guessed at.

### 4.8 Eyes closed

Too rare in the evaluation photographs to measure (2 of 591). The alignment
uses eye corners, which a closed eye still has; no rule refuses or flags
closed eyes, and regression tests pin that. How much a blink costs a real
match is not established.

### 4.9 Expression

Mouth closed 0.970, parted 0.969, open 0.967 (median, other days) — small.
The guided enrolment already asks for a smile.

### 4.10 Glasses, beard, hair

Glasses on one photograph and not the other: **half the pairs fell below the
review floor** (0.929 median; 35 pairs of 6 people; the portrait pairs agree).
Two different people who both wear glasses score higher, but none reached
0.955. **The fifth guided enrolment step now asks anyone who wears glasses
only some of the time to take that photograph the other way.** Beards,
hairstyles and hair over the face were not measurable: Azure no longer
reports them and nothing labels them.

### 4.11 Appearance over time

Same day 0.975 (95% could be marked present); under a year 0.964 (75%); one
to three years 0.957 (53%); over three 0.958 (56%, 13% below review).
Re-enrolment replaces a set that no longer matches.

### 4.12 Templates: how many, and how combined

Enrolled from one day, recognised on others (30 people, 97 classmates, 145
strangers): one frontal photograph 46.8% present / 16.4% not matched; frontal
+ left + right 55.9% / 11.7%; **the guided five 59.9% / 9.0%**. Combining a
student's templates by the best one (production) beat the mean of the best
two (54.2%), a soft maximum (52.2%) and the mean (40.8%); none marked anybody
wrong. **Unchanged.**

### 4.13 Enrolment at institution scale

The enrolment scan refused a photograph whose nearest *other* student was in
the review band. 0.096% of pairs of different people reach that band, so a
photograph checked against N students × 5 templates meets one with
probability 1 − (1 − 0.00096)^(5N): **21% at 50 students, 62% at 200, 91% at
500.** Refusing protected nobody — no two different people reached the
duplicate level (raw 0.955) in 59,587 pairs, where 79.6% of second
photographs of one person do — and left the student with no template.
**Lookalikes are now enrolled**, staff are told whom the face resembles, and
the audit row records it. Duplicates (≥ presentMin), already-enrolled samples
and own-sample mismatches are refused as before. Staff — never a student —
can confirm that two students in the duplicate band are different people
(identical twins); the confirmation names one student, waives that collision
only, and is audited as `face_enrollment.distinct_person_confirmed`.

### 4.14 Identical twins and lookalikes

For four of five pairs a photograph of one twin was as close to the other as
to themselves (cross-twin median 0.930–0.949; 8.6–46.7% at or above the
present threshold). Before this work, with both enrolled, the wrong twin was
marked present in 2.8–7.0% of their classroom appearances at five samples
each, and 23.1% at one sample for pair D.

`findLookalikeStudents` now finds pairs the recogniser cannot tell apart from
their own templates — a confident cross-match, **or at least three
cross-template comparisons in the review band** — and never marks a match to
either present on the recogniser's word. Wrong twin present, five samples
each: pair A 2.8% → **0.0%**, pair B 2.8% → **0.0%**, pair C 7.0% →
**0.0%**; three samples each: 0.2–1.6%. No unrelated pair met the rule: 0 of
351 pairs with five templates and 0 of 406 with three (a loose bound: below
about 0.9% of pairs at 95%). A false pair would cost two students review,
never a wrong record, and is visible in the run log.

## 5. The pipeline after — exactly what changed

| Where | Change |
| --- | --- |
| `services/face-ai/app/models/azure_dlib_provider.py` | `classroom_flags` and `DLIB_GROUP_PROFILE`: blur, darkness, blow-out and frame edge measured on the face; Azure's blur and exposure ratings no longer decide classroom flags |
| `services/face-ai/app/models/azure_provider.py` | `AzureQualityProfile.judge_exposure` (default unchanged for every other profile) |
| `services/face-ai/app/models/face_sharpness.py` | `face_core_outside` |
| `apps/web/.../recognition-engine/service.ts` | `findLookalikeStudents` (confident cross-match, or `LOOKALIKE_REVIEW_BAND_MATCHES` = 3 review-band comparisons) caps either student's match at review (`ambiguous_face`); `lookalikeStudents` count in the `recognition.run` log |
| `apps/web/.../face-enrollment/service.ts`, `types.ts`, `actions.ts`, `face-capture.tsx` | Lookalikes enrolled and noted; staff confirmation of distinct people, audited; staff told to complete five photographs of both |
| `apps/web/.../face-enrollment/guided-steps.ts` | Fifth step: one photograph the other way on glasses |
| `apps/web/.../audit/types.ts` | `face_enrollment.distinct_person_confirmed` |
| Tests | face-ai: classroom flags, frame edge, closed eyes; apps/web: lookalike enrolment, staff confirmation, the twin rule, glasses guidance |
| Docs | CALIBRATION.md, RECOGNITION.md, MODEL_LICENSES.md, RECOGNITION_ENGINE.md, RUNBOOK_DEPLOYMENT.md, this file |

Not changed: the detector, the recogniser and its weights, the calibration
and every threshold, the model version (no re-enrolment), the database
schema, the API contracts, the enrolment quality gate, the capture sizes,
the review workflow and its states, Azure detection-only with no `faceId`,
Key Vault-backed credentials, tenant and institution authorisation, upload
validation.

## 6. Evaluation matrix

**Pair level** — one photograph against one, at the product's two raw
thresholds:

| | Genuine pairs | FRR at 0.955 (not presentable) | FRR at 0.93 (below review) | Impostor pairs | FAR at 0.93 | FAR at 0.955 |
| --- | --- | --- | --- | --- | --- | --- |
| Portraits, years apart | 98 | 20.4% | 2.0% | 59,587 | 0.096% | **0** |
| Event photographs, other days, any pose | 4,635 | 62.1% | 25.7% | 168,113 | 0.058% | **0** (max 0.949) |
| Identical twins, across the pair | — | — | — | 693 | 51.2% | 10.4% |

**Decision level** — what a teacher sees:

| Setting | Present | Needs review | Not matched | Wrong student present | Rank-1 |
| --- | --- | --- | --- | --- | --- |
| Composed classrooms, all 19 conditions (1 template each) | 42.6% | 48.8% | 8.5% | **0** | — |
| Event photographs, guided five templates, other days | 59.9% | 31.1% | 9.0% | **0** | 93.6% |
| … one frontal template | 46.8% | 36.8% | 16.4% | **0** | 91.0% |
| Strangers, not enrolled (145) | 0 | 9–10% | 90–91% | **0** | — |
| Twins (pairs A, B, C), both enrolled, five samples each | 0% | — | — | **0.0%** | — |
| Twins, both enrolled, one sample each | — | — | — | **2.6–5.2%**; pair D 21.4% | — |
| Twins, only one enrolled | — | — | — | **5.8–51.2%** | — |

In the composed classrooms a further 343 faces were sent to review under
another student's name — a teacher sees each, and no policy marked them
present. By condition, size, pose, lighting and blur: sections 4.2–4.7 and
[CALIBRATION.md](../services/face-ai/docs/CALIBRATION.md). There is no single
accuracy number, and none is claimed.

### Performance

`analyze_image` end to end on a developer machine (Apple M5 Pro) with live
Azure: 10 faces 2.2s, 30 faces 3.0s, 50 faces 2.8s (median); Azure's round
trip is 2.2–2.8s of it, local work 4.9–7.1 ms per face, of which the new
quality measurements are 0.4–1.5 ms. Peak memory of the evaluation process
388 MiB. Production calls Azure from the same region, so that part should be
shorter; its single vCPU makes the local part slower — an estimate, not a
measurement, of 20–40 ms a face. Apps/web's lookalike search is pairwise over
the class's templates in memory: 60 students with five templates is about
45,000 dot products.

## 7. Considered, measured, and not changed

| Idea | Why not |
| --- | --- |
| Another Azure detection model | `detection_03` is the newest; `detection_02` has no landmarks |
| Tiled or multi-pass detection | 100% detection down to 40px at the product's capture size |
| Illumination normalisation | No transformation helped across conditions; each raised impostor scores somewhere (4.5) |
| Enlarging or restoring small faces | Invents detail; a small face is sent to review instead |
| Another recogniser | The markedly more pose-robust ones fail the licence gate on their weights or training data ([MODEL_LICENSES.md](../services/face-ai/docs/MODEL_LICENSES.md)) |
| Averaging or soft-maxing a student's templates | Lower recognition, no gain in safety (4.12) |
| A per-face twin rule on the runner-up | Helped only at one sample each, where nothing makes twins safe (4.14) |
| A hard rule for closed eyes | No evidence it is needed; not measurable here (4.8) |
| Lowering any threshold | Never needed: every gain above came from removing flags that did not measure what they claimed |

## 8. What still needs a person

- **Identical twins.** Both must be enrolled, with five samples each. A twin
  who is not enrolled can be marked present as their sibling (5.8–51.2% of
  their appearances measured); with one sample each, 2.6–5.2% for three pairs
  and 21.4% for the fourth.
- **Children.** Not measured. Every face in the evaluation is an adult's.
- **Real classrooms.** Composed scenes have no perspective, no neighbour's
  shoulder over a chin, no light that varies across the room.
- **Heads turned beyond 30°, looking down, glasses changed since enrolment,
  faces around 40px, severe blur and shake, heavy occlusion, faces cut off by
  the frame edge** — by design these go to review or are not matched.
- **Beards, hairstyles, hair over the face, non-twin siblings, eyes closed** —
  not measured.
- **Unrelated lookalikes** in a large institution may occasionally be
  flagged as a pair; they are sent to review, and the run log counts them.
