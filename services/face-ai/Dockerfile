# ATTENDANCE PROJECT — production image for services/face-ai (FastAPI)
#
# Build from THIS directory, not the repository root:
#   docker build -t attendance-face-ai services/face-ai
#   az acr build -r attendanceprodacr -t face-ai:<sha> services/face-ai
#
# A narrow context on purpose. This service is the one that turns a photograph
# into a biometric template, and it has no business seeing the web application,
# the Prisma schema or the infrastructure templates — ADR-0002 keeps it a pure
# function of its input, and a build context is part of that boundary.
#
# Two stages. The first compiles dlib, which needs a C++ toolchain, CMake and
# ~1 GiB of intermediate objects; none of that belongs in a running container.
# The second installs the resulting wheel, bakes the pinned recogniser weights
# in, and proves at BUILD time that the compiled network computes the values
# the thresholds were calibrated against.

# ---------------------------------------------------------------------------
# Stage 1: compile the recogniser
# ---------------------------------------------------------------------------

FROM python:3.12-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

# build-essential and cmake compile dlib. libopenblas-dev gives its matrix
# operations a tuned BLAS — the difference between a classroom photograph
# embedding in a second and in several. The runtime stage installs the
# matching libopenblas0-pthread; if it were missing, `import dlib` would fail
# in the self-test below rather than in production.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential cmake libopenblas-dev \
 && rm -rf /var/lib/apt/lists/*

COPY requirements-build.txt requirements-dlib.txt ./

# --require-hashes on both: every input to the compiled artefact is pinned by
# content, not by a version number somebody could republish.
RUN pip install --require-hashes -r requirements-build.txt \
 && pip wheel --no-binary :all: --no-build-isolation --no-deps \
      --require-hashes -r requirements-dlib.txt -w /wheels

# ---------------------------------------------------------------------------
# Stage 2: the image that runs
# ---------------------------------------------------------------------------

FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

# libgomp1 is the OpenMP runtime that onnxruntime links against. It is absent
# from python:slim, and without it `import onnxruntime` fails at startup with a
# missing-shared-object error rather than anything mentioning ONNX.
#
# libglib2.0-0 is opencv-python-headless's one remaining system dependency.
# "headless" removes the GUI stack (libGL, X11, GTK) but not glib, and without
# it `import cv2` fails with a missing libgthread — which mentions neither
# OpenCV nor glib and is a genuinely confusing first-boot failure.
#
# libopenblas0-pthread is what the compiled dlib links against. The -dev
# package from the builder stage is not needed here, only the shared library.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libgomp1 libglib2.0-0 libopenblas0-pthread \
 && rm -rf /var/lib/apt/lists/*

# Dependencies before source, so editing a handler does not reinstall
# onnxruntime.
COPY requirements.txt requirements-prod.txt ./
RUN pip install --no-cache-dir -r requirements-prod.txt

# --no-deps because dlib declares none and pip must not reach the network to
# confirm that; --no-index because nothing here may come from anywhere but the
# wheel the builder produced.
COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir --no-index --no-deps /wheels/dlib-*.whl \
 && rm -rf /wheels

# Application code only. .dockerignore keeps tests/, bench/ and dev
# requirements out of the image.
COPY app ./app
COPY scripts ./scripts

# The recogniser's weights, baked in and verified.
#
# This image is no longer model-agnostic, and that is the point. The weights
# are public domain (docs/MODEL_LICENSES.md), so shipping them inside a
# registry image is a packaging decision rather than a licensing one — which
# it was not, for the artefacts this line deliberately does not fetch.
#
# Downloaded here rather than copied from the build context so the SHA-256 in
# app/models/model_files.py is the only thing that decides what gets baked in:
# a substituted file fails the build, and nobody can slip a different
# recogniser in by dropping it in models/. The service then verifies the same
# checksum again at startup, so a layer altered after the fact does not serve.
RUN python scripts/fetch_models.py --set dlib --dir /srv/models
ENV FACE_MODEL_DIR=/srv/models

# Prove the compiled network computes what the thresholds were calibrated
# against, in the image, at build time.
#
# dlib selects SSE4/AVX code paths from the machine that compiles it, and a
# different BLAS or a miscompiled SIMD path changes the descriptors it
# produces — subtly, in a way that would show up as students who stop being
# recognised rather than as an error. This runs the same golden self-test the
# service runs at startup, so an image that would do that never gets pushed.
RUN python scripts/verify_recognizer.py --dir /srv/models

# One thread per library, because the process model is already parallel: two
# gunicorn workers against the 1 vCPU allocation. A BLAS that helpfully starts
# a thread per core would oversubscribe the container and make every request
# slower.
ENV OPENBLAS_NUM_THREADS=1 \
    OMP_NUM_THREADS=1

# A decompression-bomb guard. OpenCV will happily allocate a 2-gigapixel frame
# from a few kilobytes of PNG and take the container's whole 2 GiB with it.
# 50 megapixels is far above any camera this product sees.
ENV OPENCV_IO_MAX_IMAGE_PIXELS=50000000

# Never root. If an image-parsing bug in pillow, OpenCV or dlib is ever
# exploitable, the blast radius should not include the container's filesystem.
RUN useradd --system --create-home --uid 10001 faceai \
 && chown -R faceai:faceai /srv
USER faceai

EXPOSE 8000

# No --reload, no `uvicorn.run(debug=True)`, no development server.
#
# Two workers against the 1 vCPU / 2 GiB allocation in
# infra/azure/modules/app.bicep: embedding is CPU-bound, so more workers than
# cores would only add context switching and duplicate the loaded model in
# memory. Horizontal scale is Container Apps' job (minReplicas 1, max 3).
#
# --graceful-timeout gives an in-flight request time to finish when a revision
# is replaced; --timeout is generous because a cold model load happens inside
# the worker's startup, not the request path.
CMD ["gunicorn", "app.main:app", \
     "--worker-class", "uvicorn.workers.UvicornWorker", \
     "--workers", "2", \
     "--bind", "0.0.0.0:8000", \
     "--timeout", "120", \
     "--graceful-timeout", "30", \
     "--access-logfile", "-", \
     "--error-logfile", "-"]
