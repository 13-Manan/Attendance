# Azure AI Face backend

**Azure's role has narrowed to detection.** Production runs
`FACE_MODEL_BACKEND=azure_detection_own_recognition`, which asks Azure AI Face
one question per image — *where are the faces, and where are their
landmarks?* — and does everything that decides **who** a face belongs to in
face-ai's own process, on weights this repository ships. Identify, Verify and
the PersonGroup APIs are never called. **Nothing in this product waits on
Microsoft's Limited Access approval any more**, and no face template leaves
our infrastructure.

The recognition half — alignment, the dlib ResNet embedder, the calibration
its scores are read through, and what happens when any of it fails — is
[`services/face-ai/docs/RECOGNITION.md`](../services/face-ai/docs/RECOGNITION.md).
Its licence audit is
[`services/face-ai/docs/MODEL_LICENSES.md`](../services/face-ai/docs/MODEL_LICENSES.md).
This document is about the Azure side: the resource, the credential, what is
sent to it and what it is asked for.

`FACE_MODEL_BACKEND=azure` — the earlier backend, which used Azure for
identification as well — is still in the registry and is **not** what
production runs. It is described under "The superseded gallery backend"
below, because a gallery enrolled under it does not disappear merely because
the default changed.

apps/web never talks to Azure, never sees the endpoint or the key, and never
receives an Azure person id, persisted-face id or face id in a browser
response. Everything below happens between apps/web's server and face-ai, and
between face-ai and Azure.

## Configuration

| Where | Name | What |
|---|---|---|
| face-ai env | `FACE_MODEL_BACKEND` | `azure_detection_own_recognition` in production, `mock` locally |
| face-ai env | `FACE_MODEL_DIR` | `/srv/models` — the recogniser's weights, baked into the image |
| face-ai env | `FACE_AI_REQUIRE_PRODUCTION_MODEL` | `true` in production: refuse to start on a backend whose licence is not cleared |
| face-ai env | `AZURE_FACE_ENDPOINT` | `https://<resource>.cognitiveservices.azure.com/` |
| face-ai env | `AZURE_FACE_KEY` | `secretref:azure-face-key` — never a plain value |
| Container App secret | `azure-face-key` | Key Vault reference, system-assigned identity |
| Key Vault (`attendance-prod-keyvault`) | `AZURE-FACE-KEY` | the resource's key1 |
| face-ai env (optional) | `AZURE_FACE_TIMEOUT_S`, `AZURE_FACE_MAX_RETRIES` | 15 s, 2 |

The key is a pydantic `SecretStr`; it is never logged, returned, or included
in an error. Azure errors are reduced to their error code before they leave
the client. Images are sent to Azure and not stored anywhere.

Rotating: write the new key to the Key Vault secret and restart the face-ai
revision (`az containerapp revision restart`). Nothing in git changes.

## What Azure is asked, and what it is sent

One call per image, under `/face/v1.0`, with `detection_03`:

| API | Used for | Needs Limited Access approval |
|---|---|---|
| `POST /detect`, `returnFaceId=false` | face boxes, 27 landmarks, quality attributes | no |

That is the whole list. **No `faceId` is requested**, so Azure is not asked to
retain anything; and because the Identify family is never called, the
approval those APIs are gated behind is not on this product's critical path.
A test asserts it rather than a comment claiming it: in
`services/face-ai/tests/test_azure_dlib_provider.py`, any Azure path other
than `/detect` fails the test that provoked it.

**What Azure receives is not the uploaded file.** The image is decoded and
re-encoded as JPEG at quality 95, for two reasons that are both load-bearing:
a phone photograph's EXIF can carry GPS coordinates and the device's identity,
and re-encoding sends pixels and nothing else; and OpenCV applies EXIF
orientation when it decodes, so if Azure read orientation differently its
landmarks would describe a different frame from the pixels the face chip is
cut from — every face aligned on the wrong spot, with nothing failing
anywhere. Sending pixels in one agreed orientation removes the disagreement
instead of assuming it away.

An image beyond Azure's limits (4096 px on a side, 6 MB) is scaled down **for
detection only**; the coordinates are scaled back and the recognition chip is
always cut from the full-resolution original.

## Failure, and the credential

An Azure outage is reported as an outage. It propagates as `503` and never
becomes "no faces found", which apps/web would otherwise record as a classroom
in which nobody was present. A rejected image is `400`; a wrong or revoked key
is `502`.

Startup proves the credential rather than assuming it: after verifying the
recogniser's weights and running its self-test, face-ai makes **one Detect
call on a synthetic pattern**. A wrong key fails startup outright. An Azure
that is merely unreachable logs a warning and lets the service start, and
requests answer `503` until it returns — the distinction matters, because one
is a deployment mistake and the other is somebody else's incident.

## Limited Access — no longer waited on

Identification and verification are gated by Microsoft's Limited Access
policy ([aka.ms/facerecognition](https://aka.ms/facerecognition)), and this
resource has never been approved for them: as of 2026-09-24 a Detect call
without `returnFaceId` answers `200` and every Identify-family call answers
`403 UnsupportedFeature`. That was verified live against the production
resource, and it is precisely why detection is the only thing asked of it.

**The product no longer waits for that approval, and no screen mentions it.**
Recognition does not need it. Should the approval ever arrive it changes
nothing about how production works; it would only make the superseded gallery
backend usable again.

## The superseded gallery backend (`azure`)

Everything from here on describes `FACE_MODEL_BACKEND=azure`, which asked
Azure to identify people as well as find them. It is **not what production
runs**, and it never worked end to end, because the Limited Access approval it
depends on was never granted. It is documented because the backend is still in
the registry and because a deployment that once pointed at it has rows shaped
this way.

Under this backend, all of the following need Limited Access approval:
`POST /detect` with `returnFaceId=true`; `GET /largepersongroups?top=1` (a
capability probe that asks without sending a face); LargePersonGroup create,
train and training status; person create and delete; persisted-face add and
delete; `POST /verify`; and `POST /identify`.

While the approval is absent, face-ai's `/v1/model-info` reports
`identification: "not_approved"`; `/v1/gallery/enroll` refuses with
`409 identification_not_approved` before any image is sent; and `/v1/identify`
still detects and counts faces but returns them with no candidates, so every
student is `NEEDS_REVIEW` with reason `identification_unavailable` and the
teacher takes the register as a roll call. face-ai re-probes every 5 minutes
(30 s after a transient failure).

### Templates

A gallery sample is a `FaceEmbedding` row with `embedding` NULL,
`embeddingDim` 0 and the model name `azure-face`, plus one
`FaceGalleryPlacement` row per class gallery it was added to (gallery id
`att-<cohortId>`, the student id as the person name). Every candidate query
filters on model, so vector rows and gallery rows are never compared with
each other. Existing mock/local embeddings are **not** valid Azure templates:
after the switch they read as "enrolled under a different model" and the
student needs re-enrolling (the usual replace path). Nothing is deleted.

### Enrollment

1. `Detect` on the image. It must contain exactly one face, which must pass
   the enrollment profile: face ≥ 100 px, `qualityForRecognition` high, blur
   low, |yaw| ≤ 30°, |pitch| ≤ 25°, |roll| ≤ 30°, not under/over-exposed, eyes
   and mouth not occluded, no mask.
2. Identify the face against each of the student's class galleries. Another
   person at ≥ 0.7 is refused as `duplicate_identity`.
3. If the student already has a person in that gallery, verify against it.
   Below 0.5 is refused as `does_not_match_student`. A replace skips this
   check, because it is the path for a face that has changed.
4. Add the face (create the person if needed) and train. Write the rows. If
   the database write fails, the placements Azure just stored are removed
   again.

The guided flow collects several samples per student. A student with no
active class is refused (`no_active_class`): there is no gallery to add them
to.

### Group photos

1. `Detect` with face ids. The group profile flags weak faces rather than
   dropping them: face ≥ 40 px, recognition quality medium or better, blur
   low/medium, and looser pose limits. Faces under 24 px are not identified.
2. `Identify` against **the session's class gallery only**, 10 face ids per
   request, at most 5 candidates each, floor 0.4.
3. apps/web resolves each person to a student through placements of *active*
   samples of students *actively enrolled* in that class (and subject). A
   person who resolves to nobody is never attributed.
4. Thresholds, in Azure confidence units and deliberately not the
   institution's cosine thresholds:

   | Confidence | Result |
   |---|---|
   | ≥ 0.75 | Present suggestion |
   | 0.5 – 0.75 | Needs review |
   | < 0.5 | Unknown face |

   If the top two students, or the top student and an unresolved person, are
   within 0.1, the face goes to review.
5. Matching is one-to-one across the session. Several photos merge into the
   same session and a student is counted once. A student with a template who
   was not found is "Not detected". That is not Absent until the teacher
   confirms the register, and nothing is committed before that.

These numbers are **not calibrated** against this product's own classrooms.
They follow Microsoft's guidance and are conservative. Change them in
`apps/web/src/modules/face-gallery/policy.ts` and
`services/face-ai/app/models/azure_provider.py`, where the change is reviewed.

### Known limits of the gallery backend

- A student who joins a new class after enrolling is not in that class's
  gallery. Images are not stored, so they need a new sample. Until then they
  read as "no comparable template" in that class, not as absent.
- Retiring a sample removes its faces from Azure afterwards and retries on
  failure. An erasure is refused rather than reported done while Azure still
  holds a face.

## What replaced all of that

Under `azure_detection_own_recognition` there is no gallery, no person, no
persisted face and no training step. A template is an ordinary
`FaceEmbedding` row holding a 128-d vector this service computed, in our
database, compared by our own code; enrolment is a quality gate and an
embedding, and a student who changes class needs nothing done to them because
the candidate pool is a query rather than a stored group. The erasure problem
above disappears with it: deleting the row is the erasure, and there is no
copy in somebody else's service to chase.

What is kept from the gallery era is the shape of the safeguards, not the
numbers — one student per face, a review band, and no path from uncertainty to
present. The thresholds those safeguards use are the institution's, read
through a measured calibration rather than in Azure confidence units;
[`services/face-ai/docs/CALIBRATION.md`](../services/face-ai/docs/CALIBRATION.md)
is where they come from, and
[`RECOGNITION_ENGINE.md`](RECOGNITION_ENGINE.md) is how they are applied.
