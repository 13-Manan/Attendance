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

FROM python:3.12-slim AS base

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
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

# Dependencies before source, so editing a handler does not reinstall
# onnxruntime.
COPY requirements.txt requirements-prod.txt ./
RUN pip install --no-cache-dir -r requirements-prod.txt

# Application code only. .dockerignore keeps tests/, bench/ and dev
# requirements out of the image.
COPY app ./app
COPY scripts ./scripts

# Model weights are NOT baked into this image.
#
# They are ~37 MiB of binary whose commercial-use status is unresolved
# (app/models/LICENSING.md), so shipping them inside an image that gets pushed
# to a registry is a licensing decision, not a packaging one. The image is
# therefore model-agnostic: mount or copy verified artefacts to FACE_MODEL_DIR,
# and the backend verifies their SHA-256 at startup before OpenCV opens them.
#
# With the default FACE_MODEL_BACKEND=mock no weights are needed at all, which
# is what makes this image deployable while the licensing question is open.
#
# To build an image that does carry them, add — deliberately, and only once the
# licence question is settled:
#     RUN python scripts/fetch_models.py --dir /srv/models
#     ENV FACE_MODEL_DIR=/srv/models

# Never root. If an image-parsing bug in pillow or onnxruntime is ever
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
