import os
import sys

# The service is run as `uvicorn app.main:app` from this directory, so `app`
# is a top-level package. Make imports resolve the same way under pytest
# regardless of where it is invoked from.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from app.config import reset_model_cache


@pytest.fixture(autouse=True)
def _clean_model_cache():
    """Backend selection is memoised, so a test that changes the environment
    would otherwise inherit the previous test's provider."""
    reset_model_cache()
    yield
    reset_model_cache()
