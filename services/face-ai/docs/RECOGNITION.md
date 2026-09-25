# The recognition engine: Azure detects, this service recognises

`FACE_MODEL_BACKEND=azure_detection_own_recognition` — what production runs.

Azure AI Face is asked one question per image: *where are the faces, and where
are their landmarks?* Everything that decides **who** a face belongs to
happens in this process and in apps/web. Identify, Verify and the PersonGroup
APIs are never called, so nothing this backend does waits on Microsoft's
Limited Access approval, and no face template ever leaves our infrastructure.

```
   classroom photograph (apps/web)
        │  base64, over the internal network, token-authenticated
        ▼
   ┌─────────────────────────────────────────────────────────┐
   │ services/face-ai                                        │
   │                                                         │
   │  decode ──► re-encode as JPEG ──► Azure Detect ─────┐   │
   │    │          (strips EXIF)                         │   │
   │    │                            faces + 27 landmarks◄───┘
   │    │                                   │                │
   │    └── original pixels ────────────┐   │                │
   │                                    ▼   ▼                │
   │                           align (dlib, 150×150 chip)    │
   │                                    │                    │
   │                                    ▼                    │
   │                       embed (dlib ResNet → 128-d)       │
   │                                    │                    │
   │                            quality flags per face       │
   └────────────────────────────────────┼────────────────────┘
                                        ▼
   ┌─────────────────────────────────────────────────────────┐
   │ apps/web                                                │
   │  class-scoped candidates (pgvector) ─► cosine           │
   │      ─► calibrate onto the product's scale              │
   │      ─► one student per face (FACE_ASSIGNMENT.md)       │
   │      ─► demote flagged / contested faces                │
   │      ─► merge the round's photographs                   │
   │      ─► PRESENT / NEEDS_REVIEW / UNKNOWN / NOT_DETECTED │
   │      ─► teacher review ─► attendance                    │
   └─────────────────────────────────────────────────────────┘
```

## The pipeline, stage by stage

| Stage | What runs | Where |
| --- | --- | --- |
| detect | Azure `detection_03`, no `faceId` | Microsoft |
| align | dlib similarity transform onto its 5-point template | this container |
| embed | `dlib_face_recognition_resnet_model_v1`, 128-d, L2-normalised | this container |
| retrieve | class-scoped active templates of the same model version | Postgres |
| score | cosine, then the published calibration | apps/web |
| assign | greedy maximum-weight bipartite matching | apps/web |
| classify | present / review / unknown / not detected | apps/web |

`/v1/model-info` reports all of it, per stage, with each stage's licence
posture.

### What Azure receives, and why it is not the uploaded file

The decoded pixels, re-encoded as JPEG at quality 95. Never the bytes that
arrived. Two reasons, both load-bearing:

- **Privacy.** A phone photograph's EXIF can carry GPS coordinates and the
  device's identity. Re-encoding sends pixels and nothing else.
- **Correctness.** OpenCV applies EXIF orientation when it decodes. If Azure
  read orientation differently, its landmarks would describe a different frame
  from the pixels the chip is cut from — every face aligned on the wrong spot,
  with nothing failing and no error anywhere. Sending pixels in one agreed
  orientation removes the disagreement rather than assuming it away.

An image beyond Azure's limits (4096 px on a side, 6 MB) is scaled down **for
detection only**; the coordinates are scaled back and the chip is always cut
from the full-resolution original, so a large photograph is not silently
recognised at thumbnail quality.

### Alignment

dlib's recogniser was trained on 150×150 chips aligned by dlib's own 5-point
model: the outer and inner corner of each eye, and the base of the nose. A
chip only means what the network expects if those five points land where they
did in training.

Azure gives the four eye corners directly. It has no point at the base of the
nose, so the fifth is derived from the midpoint of the two nostril out-tips,
shifted by an offset measured over 151 portraits — which cuts the median nose
error from 0.161 to 0.032 inter-eye distances
([CALIBRATION.md](CALIBRATION.md)). The offset is applied in the face's own
frame, so it follows a rolled head.

Azure names landmarks from the viewer's side (`eyeLeftOuter` is on the image's
left, which is the subject's *right* eye); dlib's order starts from the
subject's left. The mapping is spelled out in `app/models/dlib_recognition.py`
and verified on every evaluation portrait. Getting it backwards would mirror
every chip and produce descriptors that are self-consistent and wrong.

Landmarks that are not plausibly a face — corners out of order, nose above the
eyes, eyes a few pixels apart — are refused. The face is reported as
`alignment_failed`. **It is never embedded from an unaligned crop**: a chip
the network did not expect yields a vector that is confidently wrong.

### Determinism

`num_jitters=0`: no random augmentation, so the same chip always gives the
same vector. A batch of chips and the same chips one at a time agree to within
4e-7, which matters because enrolment embeds one face and the classroom path
embeds many.

At load, the network is run on a fixed synthetic chip and compared against
pinned values. A dlib build that computes something else — a different BLAS, a
miscompiled SIMD path, substituted weights — fails startup instead of quietly
writing templates nothing else can match. The same check runs during the image
build (`scripts/verify_recognizer.py`), so such an image is never pushed.

### Scores

Raw dlib cosines are **not** on the product's scale: most pairs of different
people score above 0.85. The service publishes a measured map
(`calibration` on `/v1/model-info`) and apps/web applies it before any
threshold sees a score. A production embedding backend that publishes no map
is refused rather than read raw. See [CALIBRATION.md](CALIBRATION.md).

### Enrolment quality

A photograph is enrolled only if it holds exactly one face, at least 100px,
facing the camera, properly exposed, uncovered, rated `high` for recognition
by Azure — and not blurred. **Blur is the one quality this service measures
itself** rather than taking Azure's rating: Azure's `blur` attribute rises as
a face gets smaller whatever its focus, and refused sharp webcam captures as
"blurry" (28 of 60 at 120px). The measure (`app/models/face_sharpness.py`) is
taken on the face alone, at the recogniser's scale, over its strongest edges,
in four directions; its threshold is set by what blur costs a template. A face
that is too small is told to move closer before blur is judged at all. The
evidence is in [CALIBRATION.md](CALIBRATION.md#enrolment-sharpness).

## Failure behaviour

The rule: **an outage is an outage.** It never becomes "no faces found", which
apps/web would record as a classroom in which nobody was present.

| Situation | Response |
| --- | --- |
| Azure unreachable, timing out, 5xx | 503 with a code, no partial result |
| Azure rejects the image | 400 |
| Azure key wrong or revoked | 502; startup fails outright on a bad key |
| Face smaller than 32 px | reported as `face_too_small`, not embedded |
| Landmarks unusable | reported as `alignment_failed`, not embedded |
| Recogniser returns nothing usable for a face | reported as `embedding_failed` |
| Face detected but low quality | **embedded, and flagged** — apps/web caps it at review |
| No face in the photograph | an ordinary empty result, not an error |

Rejected faces carry their box and their reason so a teacher can be told
"three faces were too small to identify" — which is actionable — rather than
having them silently vanish, which is indistinguishable from those students
being absent.

## Versioning, and when templates stop being comparable

`modelVersion` is `<weights>+pp<preprocessing>+al<alignment>`, currently
`dlib-models-2a61575+pp1+al1.detection_03`. Candidate retrieval filters on it,
so a template written by a different build is never compared against a current
one — it is counted and reported as skipped, not silently ignored.

The alignment component includes Azure's detection model, because the
landmarks are part of the alignment: if Microsoft changes `detection_03`, the
chips change, and the templates are no longer comparable. Changing any
component flips every existing template to `NEEDS_REENROLLMENT`
automatically, which is the mechanism, not a manual step.

`FaceEmbedding.alignmentVersion` stores the same value on its own so that
prompt can be written without parsing the composite string.

## Operating it

| Variable | Value in production |
| --- | --- |
| `FACE_MODEL_BACKEND` | `azure_detection_own_recognition` |
| `FACE_MODEL_DIR` | `/srv/models` (baked into the image) |
| `FACE_AI_REQUIRE_PRODUCTION_MODEL` | `true` |
| `AZURE_FACE_ENDPOINT` | the resource endpoint; server-side only |
| `AZURE_FACE_KEY` | Key Vault reference; never logged, never in a response |

Startup order, all of it fail-fast: verify the weights' SHA-256 → load the
network → run the golden self-test → build the Azure client → one Detect call
on a synthetic pattern to prove the credential. A wrong key stops the service.
An Azure that is merely unreachable logs a warning and starts; requests answer
503 until it returns.

Checks that do not need a running service:

```bash
python scripts/verify_recognizer.py          # weights + golden self-test
python scripts/fetch_models.py --check       # artefact checksums only
python scripts/sbom.py --pretty              # what is actually installed
```

## Related

- [MODEL_LICENSES.md](MODEL_LICENSES.md) — the licence audit, including the
  one question referred for legal review
- [CALIBRATION.md](CALIBRATION.md) — the measurements behind the thresholds
- [../../../docs/FACE_ASSIGNMENT.md](../../../docs/FACE_ASSIGNMENT.md) — one
  student, one face
- [../../../docs/RECOGNITION_ENGINE.md](../../../docs/RECOGNITION_ENGINE.md) —
  the apps/web half
- [../app/models/LICENSING.md](../app/models/LICENSING.md) — how a backend
  gets cleared at all
