# One student, one face: the assignment algorithm

A classroom photograph contains several faces and the class contains several
students, and the obvious way to match them is also wrong: score every face
against every student and give each face its best match independently. Do that
and the same student is handed to two faces, because two faces really can
resemble one person — siblings, cousins, or simply a recogniser having a bad
day with a turned head.

So the faces in one photograph are matched to students **jointly**: a student
may be given at most one face per photograph.

The worked example from the specification, which is a test
(`service.test.ts`, "a student contested by two faces is given to one of them
and reviewed"):

```
Detected faces and their candidates:
  F1 → Rahul .81, Aman .79
  F2 → Rahul .80, Aman .65
  F3 → Priya .90

Result:
  F3 → Priya   (assigned)
  F1 → Rahul   (assigned — the clearest claim on Rahul)
  F2 → Aman    (reassigned; recorded as such, never a confident match)
  Rahul is contested → his result goes to a teacher
```

## The algorithm

`assignFacesOneToOne` in `apps/web/src/modules/recognition-engine/service.ts`.

1. Drop every (face, student) pair scoring below the review floor. A pair that
   is not even worth a human's attention is not an assignment candidate.
2. Sort the surviving pairs by score, highest first.
3. Walk the list once. Take a pair if the face is still unassigned *and* the
   student is still unclaimed. Otherwise skip it.
4. A face that did not get its top choice is marked `reassigned`. A face with
   nothing left is assigned nobody and becomes an unknown face — never a
   guess.
5. Any student who was the *top choice* of two or more faces is `contested`.
   They keep the stronger face, and their result is sent to a teacher
   regardless of how high that score was.

Ties are broken by face index, then by student id, so the result does not
depend on the order the faces arrived in. There is a test for that.

This is greedy maximum-weight bipartite matching. It produces a *stable*
matching: no face–student pair would both rather have each other than what
they got.

## Why not Hungarian

The Hungarian algorithm (or any min-cost-flow formulation) finds the
assignment maximising the **sum** of the scores. That is the textbook answer,
and it is the wrong objective here.

**A sum of cosine similarities is not a likelihood.** Maximising it is
maximising a quantity with no probabilistic meaning, and the optimum can be
reached by making an individual assignment worse. Concretely:

```
  F1 → Alice .80, Bob .78
  F2 → Alice .79, Bob .50

  Greedy:    F1→Alice (.80), F2→Bob (.50)   sum 1.30
  Hungarian: F1→Bob   (.78), F2→Alice (.79) sum 1.57
```

Hungarian wins on the sum, and it does so by giving F1 to Bob — a student who
is **not** F1's best match, and whose score against F1 no single comparison
supports. If .78 happens to clear the present threshold, the system has just
marked Bob present on the strength of an arithmetic total rather than on the
strength of Bob's face being in the photograph. There is no honest sentence to
write on the review screen explaining that.

The greedy result has a sentence: *"the face that resembled Alice most clearly
got Alice."* A teacher can check that claim against the photograph. That is
worth more than a larger sum.

Three further reasons, in order of how much they matter:

1. **The scores are not commensurable enough to add.** Two faces in one
   photograph differ in size, sharpness and angle. Their similarity scores are
   drawn from different effective distributions, so adding them across faces
   compares quantities that are not on the same footing — even after the
   backend's calibration, which maps a scale, not a per-face confidence.
2. **Failure modes differ.** Greedy's failure is a face left unassigned, which
   surfaces as an unknown face and a review. Hungarian's failure is a
   confident-looking assignment nobody asked for. Between "we could not tell"
   and "we told you the wrong thing", this product always takes the first.
3. **Explainability under audit.** When an attendance record is challenged,
   the answer must be reconstructible from stored numbers. Greedy's answer is
   one comparison. Hungarian's answer is a global optimisation over a matrix
   that was not stored.

Cost is not the reason. A class is tens of faces against tens of students and
Hungarian would be entirely affordable. It is not used because its objective
does not match the product's.

## What the assignment deliberately does not do

- **It does not lower the bar to fill a slot.** The review floor is applied
  before assignment, not after. A face whose only remaining candidate is below
  it stays unknown.
- **It does not promote a reassignment.** A face that lost its top choice and
  took its second is capped: `reassigned` faces are never a confident match,
  whatever they scored.
- **It does not resolve `contested` quietly.** The losing face is not simply
  dropped; the *winning* student is flagged. Two faces claiming one person
  means the recogniser is confusing people, and the right response to that is
  a human, not a tie-break.
- **It does not run across photographs.** Assignment is within one image,
  because "two faces in one photograph are two different people" is only true
  within one photograph. Merging the evidence from several photographs of the
  same round is a separate step, with its own rule: a student cannot become
  present merely by being detected repeatedly.

## Where this sits

```
  detect → align → embed        (services/face-ai)
    ↓
  score against class templates  (calibrated; recognition-engine/service.ts)
    ↓
  assignFacesOneToOne            ← this document, per photograph
    ↓
  quality and contest demotions
    ↓
  merge across the round's photographs
    ↓
  per-student advisory result → teacher review → attendance
```

Related: [`RECOGNITION_ENGINE.md`](RECOGNITION_ENGINE.md) for the pipeline as a
whole, and
[`../services/face-ai/docs/CALIBRATION.md`](../services/face-ai/docs/CALIBRATION.md)
for where the thresholds the floor and the margins use come from.
