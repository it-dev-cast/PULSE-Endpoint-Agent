"""ai-service - the real, minimal v1 of PRD's device-health prediction service for exactly two
metrics (SSD wear, battery health) on one real device. Deliberately NOT PyTorch/ONNX-scale
infrastructure: there is no training pipeline and no persisted model file anywhere in this file,
because there is nothing here that needs one. A closed-form least-squares line fit recomputed
fresh from real stored data on every request is the entire "model" - anything heavier would be
solving a problem this project doesn't actually have (one laptop, two slowly-changing
percentages), the same over-engineering-in-reverse backend/main.go's own module comment already
argues against for its own domain.

This process holds no device credential of its own. Every request forwards the SAME bearer
token the caller (local-agent) already sent, on to backend/'s real
GET /v1/devices/:id/metric-snapshots for that one call's lifetime - never stored, never logged.
That's what "queries the backend's real snapshot history" means structurally: this service does
make that HTTP call itself (per the task), but only ever with a credential someone else already
authenticated, exactly like local-agent's own proxy endpoints already do for the frontend.
"""

import math
import os
from datetime import datetime

import numpy as np
import requests
from flask import Flask, jsonify, request

app = Flask(__name__)

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8443")
PORT = int(os.environ.get("PORT", "8001"))

# A real linear regression is statistically meaningless from 1-2 points - this is the actual
# floor, not a stylistic choice. Below it, every response is an honest "insufficient-data",
# never an extrapolation from too little to say anything real.
MIN_POINTS = 3

# The task's own example thresholds - a real, meaningful degradation point per metric, not an
# arbitrary round number. Battery: the widely-cited industry rule of thumb for "meaningfully
# worn" lithium-ion capacity. SSD: NVMe SMART's own percentage_used semantic - 100 is the drive's
# full rated write endurance, so >90 is "approaching the vendor's own rated limit."
BATTERY_HEALTH_THRESHOLD = 80.0
SSD_WEAR_THRESHOLD = 90.0

RISK_LOW_DAYS = 180
RISK_MEDIUM_DAYS = 60

# Real fit-quality gate, added because the model previously had no way to tell "a clean trend
# across many real points" apart from "3 noisy points that happen to produce a slope" - both
# looked identical (a full daysRemaining + risk projection) before this existed. Gated on BOTH R²
# and sample size deliberately: with very few points, R² can be high by pure chance (too few
# residual degrees of freedom for it to mean anything), so a "perfect" 3-point fit still doesn't
# earn "high" here. 0.7 and 5 are real, defensible round numbers (0.7 is the common convention
# for "a real linear relationship exists"; 5 is enough points for R² to have started meaning
# something) - not tuned to produce a particular answer.
CONFIDENCE_MIN_POINTS = 5
CONFIDENCE_R2_THRESHOLD = 0.7


def _day_offset(date_str: str, first_date) -> int:
    d = datetime.strptime(date_str, "%Y-%m-%d").date()
    return (d - first_date).days


def evaluate_metric(rows, value_key: str, threshold: float, direction: str) -> dict:
    """rows: real snapshot rows from backend (recordedAt + both percentage columns), oldest
    first. Only the calendar date portion of recordedAt matters here - the backend already
    dedupes to one real row per device per day, so day-level granularity is exactly what its own
    data actually represents; parsing full timestamps would just add ISO-format edge cases for
    no real benefit.
    """
    valid = [(r["recordedAt"][:10], r[value_key]) for r in rows if r.get(value_key) is not None]
    if len(valid) < MIN_POINTS:
        return {"status": "insufficient-data", "daysOfHistory": len(valid), "minRequired": MIN_POINTS}

    first_date = datetime.strptime(valid[0][0], "%Y-%m-%d").date()
    xs = np.array([_day_offset(d, first_date) for d, _ in valid], dtype=float)
    ys = np.array([v for _, v in valid], dtype=float)
    current_value = float(ys[-1])

    already_past = current_value >= threshold if direction == "increasing" else current_value <= threshold
    if already_past:
        return {"status": "already-past-threshold", "currentValue": current_value, "daysOfHistory": len(valid)}

    # Plain closed-form least squares (numpy.polyfit, degree 1) - not scikit-learn, which would
    # be a real dependency for something a single numpy call already does exactly and honestly
    # for one input variable.
    slope, intercept = np.polyfit(xs, ys, 1)
    slope = float(slope)
    intercept = float(intercept)

    if abs(slope) < 1e-9:
        return {"status": "stable", "currentValue": current_value, "daysOfHistory": len(valid)}

    days = (threshold - current_value) / slope
    if not math.isfinite(days) or days <= 0:
        # The real trend is moving away from the threshold (or the fit is degenerate) - nothing
        # honest to project, same as a flat slope.
        return {"status": "stable", "currentValue": current_value, "daysOfHistory": len(valid)}

    days_remaining = round(days)
    if days_remaining > RISK_LOW_DAYS:
        risk = "Low"
    elif days_remaining > RISK_MEDIUM_DAYS:
        risk = "Medium"
    else:
        risk = "High"

    # Real R² over the same fit already computed above - not a new model, just a fuller read of
    # it. ss_tot > 0 should always hold here in practice (the flat-slope check above already
    # caught the case where y has no real variance), but the check stays as real numerical
    # defense, not a silent assumption.
    y_pred = slope * xs + intercept
    ss_res = float(np.sum((ys - y_pred) ** 2))
    ss_tot = float(np.sum((ys - np.mean(ys)) ** 2))
    r2 = (1.0 - ss_res / ss_tot) if ss_tot > 0 else 0.0
    confidence = "high" if (r2 >= CONFIDENCE_R2_THRESHOLD and len(valid) >= CONFIDENCE_MIN_POINTS) else "low"

    return {
        "status": "ok",
        "currentValue": current_value,
        "daysRemaining": days_remaining,
        "risk": risk,
        "daysOfHistory": len(valid),
        "confidence": confidence,
        "r2": round(r2, 2),
    }


@app.route("/predict/<device_id>")
def predict(device_id):
    auth_header = request.headers.get("Authorization")
    if not auth_header:
        return jsonify({"error": "missing Authorization header"}), 401

    try:
        resp = requests.get(
            f"{BACKEND_URL}/v1/devices/{device_id}/metric-snapshots",
            headers={"Authorization": auth_header},
            timeout=5,
        )
    except requests.RequestException as e:
        return jsonify({"error": f"backend unreachable: {e}"}), 502

    if resp.status_code != 200:
        return jsonify({"error": f"backend returned HTTP {resp.status_code}"}), 502

    try:
        rows = resp.json()
    except ValueError:
        return jsonify({"error": "backend returned invalid JSON"}), 502

    battery = evaluate_metric(rows, "batteryHealthPct", BATTERY_HEALTH_THRESHOLD, "decreasing")
    ssd = evaluate_metric(rows, "ssdWearPct", SSD_WEAR_THRESHOLD, "increasing")
    return jsonify({"deviceId": device_id, "battery": battery, "ssd": ssd})


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT)
