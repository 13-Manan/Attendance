"""Repeatable face-recognition benchmark harness.

This package exists to answer one question that no amount of code review can:
*what thresholds should this deployment actually use, and how wrong is it at
those thresholds?* The Phase 5 requirement is explicit — threshold values must
come from measurement against real classrooms, not from a number someone liked
the look of.

The harness is split so that the expensive part runs once and the analysis
runs as often as you like:

    manifest.py   describes a benchmark dataset (cohorts, captures, ground
                  truth, and the conditions each capture was shot under)
    runner.py     executes the model over that dataset and records RAW
                  similarities, detection counts and timings — no decisions
    metrics.py    turns raw results into detection rate / accuracy / false
                  acceptance / false rejection / latency AT A GIVEN THRESHOLD,
                  and sweeps a threshold grid to produce an operating curve
    report.py     renders a run as JSON (machine) and Markdown (human)

Because `runner` stores raw scores, re-running the analysis at a different
threshold costs milliseconds and zero inference. That is what makes threshold
selection a measurement rather than a guess.
"""
