# Azure AI Face backend

`FACE_MODEL_BACKEND=azure` puts face-ai in front of an Azure AI Face resource.
apps/web never talks to Azure, never sees the endpoint or the key, and never
receives an Azure person id, persisted-face id or face id in a browser
response. Everything below happens between apps/web's server and face-ai, and
between face-ai and Azure.

## Configuration

| Where | Name | What |
|---|---|---|
| face-ai env | `FACE_MODEL_BACKEND` | `azure` in production, `mock` locally |
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

## Azure APIs used

All under `/face/v1.0`, with `detection_03` + `recognition_04`.

| API | Used for | Needs Limited Access approval |
|---|---|---|
| `POST /detect` (quality attributes, landmarks, no face id) | quality gates, face counts | no |
| `POST /detect` with `returnFaceId=true` | a face id to identify or verify | **yes** |
| `GET /largepersongroups?top=1` | capability probe — asks without sending a face | yes |
| LargePersonGroup create / train / training status | one gallery per class | yes |
| LargePersonGroup person create / delete, persistedfaces add / delete | enrollment, retirement, erasure | yes |
| `POST /verify` (face to person) | enrollment own-identity check | yes |
| `POST /identify` | group photos, ≤ 10 face ids per request | yes |

## Limited Access

Identification and verification are gated by Microsoft's Limited Access
policy. **A new S0 resource can detect but not identify** until the
application at <https://aka.ms/facerecognition> is approved. Until then Azure
answers `403 UnsupportedFeature`, and:

- face-ai's `/v1/model-info` reports `identification: "not_approved"`.
- `/v1/gallery/enroll` refuses with `409 identification_not_approved` before
  any image is sent. Staff and teachers see "Face identification is awaiting
  Azure approval" (or "temporarily unavailable" when Azure is unreachable,
  which is retryable and never worded as a pending approval).
- `/v1/identify` still detects and counts faces and returns them with no
  candidates. Every student is `NEEDS_REVIEW` with reason
  `identification_unavailable`. Nobody is marked present or absent by the
  AI, and the teacher takes the register as a roll call.

face-ai re-probes every 5 minutes (30 s after a transient failure), so once
approval lands, identification switches on with no redeploy.

## Templates

A gallery sample is a `FaceEmbedding` row with `embedding` NULL,
`embeddingDim` 0 and the model name `azure-face`, plus one
`FaceGalleryPlacement` row per class gallery it was added to (gallery id
`att-<cohortId>`, the student id as the person name). Every candidate query
filters on model, so vector rows and gallery rows are never compared with
each other. Existing mock/local embeddings are **not** valid Azure templates:
after the switch they read as "enrolled under a different model" and the
student needs re-enrolling (the usual replace path). Nothing is deleted.

## Enrollment

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

## Group photos

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

## Known limits

- A student who joins a new class after enrolling is not in that class's
  gallery. Images are not stored, so they need a new sample. Until then they
  read as "no comparable template" in that class, not as absent.
- Retiring a sample removes its faces from Azure afterwards and retries on
  failure. An erasure is refused rather than reported done while Azure still
  holds a face.
