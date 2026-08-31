"""Real unit tests for ai-service's actual regression logic - not smoke tests. Each test computes
its expected numbers by hand (see comments) and asserts the function produces exactly that, so a
future change to the math is caught, not just "does it crash."
"""

from unittest.mock import Mock, patch

import app as app_module
from app import app, evaluate_metric


def rows_from(values, key="batteryHealthPct", other_key="ssdWearPct"):
    """Builds real-shaped snapshot rows (one per day, starting 2026-01-01) with `values` in
    `key` and None in `other_key` - mirrors exactly what backend's GET
    /v1/devices/:id/metric-snapshots returns."""
    out = []
    for i, v in enumerate(values):
        out.append({"recordedAt": f"2026-01-{i + 1:02d}T00:00:00Z", key: v, other_key: None})
    return out


def test_insufficient_data_below_minimum():
    rows = rows_from([90.0, 88.0])
    result = evaluate_metric(rows, "batteryHealthPct", 80.0, "decreasing")
    assert result == {"status": "insufficient-data", "daysOfHistory": 2, "minRequired": 3}


def test_other_metric_being_null_does_not_block_this_metric():
    # 3 real battery points, but ssdWearPct is null on all of them - battery's own count must
    # still reach 3 (its own real data), unaffected by ssd having nothing this whole period.
    rows = rows_from([90.0, 88.0, 86.0])
    result = evaluate_metric(rows, "batteryHealthPct", 80.0, "decreasing")
    assert result["status"] == "ok"
    assert result["daysOfHistory"] == 3


def test_battery_declining_projects_real_days_remaining():
    # day0=90, day1=88, day2=86 - exactly -2/day. threshold 80: (80-86)/-2 = 3 days.
    rows = rows_from([90.0, 88.0, 86.0])
    result = evaluate_metric(rows, "batteryHealthPct", 80.0, "decreasing")
    assert result["status"] == "ok"
    assert result["currentValue"] == 86.0
    assert result["daysRemaining"] == 3
    assert result["risk"] == "High"


def test_ssd_increasing_projects_real_days_remaining():
    # day0=10, day1=15, day2=20 - exactly +5/day. threshold 90: (90-20)/5 = 14 days.
    rows = rows_from([10.0, 15.0, 20.0], key="ssdWearPct", other_key="batteryHealthPct")
    result = evaluate_metric(rows, "ssdWearPct", 90.0, "increasing")
    assert result["status"] == "ok"
    assert result["currentValue"] == 20.0
    assert result["daysRemaining"] == 14
    assert result["risk"] == "High"


def test_battery_already_past_threshold():
    rows = rows_from([75.0, 74.0, 73.0])
    result = evaluate_metric(rows, "batteryHealthPct", 80.0, "decreasing")
    assert result["status"] == "already-past-threshold"
    assert result["currentValue"] == 73.0


def test_ssd_already_past_threshold():
    rows = rows_from([92.0, 93.0, 95.0], key="ssdWearPct", other_key="batteryHealthPct")
    result = evaluate_metric(rows, "ssdWearPct", 90.0, "increasing")
    assert result["status"] == "already-past-threshold"
    assert result["currentValue"] == 95.0


def test_flat_trend_is_stable_not_a_fabricated_projection():
    rows = rows_from([90.0, 90.0, 90.0])
    result = evaluate_metric(rows, "batteryHealthPct", 80.0, "decreasing")
    assert result["status"] == "stable"
    assert result["currentValue"] == 90.0


def test_improving_trend_is_stable_not_a_negative_projection():
    # Battery health going UP (unusual, but a bad sensor reading or genuine recalibration could
    # cause it) must never produce a fabricated "days remaining" - there's nothing to honestly
    # project toward degradation here.
    rows = rows_from([80.0, 85.0, 90.0])
    result = evaluate_metric(rows, "batteryHealthPct", 80.0, "decreasing")
    assert result["status"] == "stable"


def test_risk_tier_boundaries():
    # slope = -1/day over 3 days (90, 89, 88) - current value 88 in every case below, only the
    # threshold changes to land daysRemaining exactly on each real boundary.
    rows = rows_from([90.0, 89.0, 88.0])

    # days = (28-88)/-1 = 60 exactly - only *greater than* 60 counts as Medium, so 60 is High.
    result_high = evaluate_metric(rows, "batteryHealthPct", 28.0, "decreasing")
    assert result_high["daysRemaining"] == 60
    assert result_high["risk"] == "High"

    # days = (27-88)/-1 = 61 - just past the High/Medium boundary.
    result_medium = evaluate_metric(rows, "batteryHealthPct", 27.0, "decreasing")
    assert result_medium["daysRemaining"] == 61
    assert result_medium["risk"] == "Medium"

    # days = (-93-88)/-1 = 181 - just past the Medium/Low boundary.
    result_low = evaluate_metric(rows, "batteryHealthPct", -93.0, "decreasing")
    assert result_low["daysRemaining"] == 181
    assert result_low["risk"] == "Low"


def test_predict_endpoint_forwards_bearer_token_and_returns_both_metrics():
    client = app.test_client()
    fake_rows = [
        {"recordedAt": "2026-01-01T00:00:00Z", "batteryHealthPct": 90.0, "ssdWearPct": 10.0},
        {"recordedAt": "2026-01-02T00:00:00Z", "batteryHealthPct": 88.0, "ssdWearPct": 15.0},
        {"recordedAt": "2026-01-03T00:00:00Z", "batteryHealthPct": 86.0, "ssdWearPct": 20.0},
    ]
    fake_response = Mock(status_code=200)
    fake_response.json.return_value = fake_rows

    with patch.object(app_module.requests, "get", return_value=fake_response) as mock_get:
        resp = client.get("/predict/device_abc123", headers={"Authorization": "Bearer real-token"})
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["deviceId"] == "device_abc123"
        assert body["battery"]["status"] == "ok"
        assert body["ssd"]["status"] == "ok"

        # The exact same bearer token must be forwarded to backend - never a service-held
        # credential of its own.
        called_headers = mock_get.call_args.kwargs["headers"]
        assert called_headers["Authorization"] == "Bearer real-token"
        called_url = mock_get.call_args.args[0]
        assert "device_abc123" in called_url


def test_predict_endpoint_requires_authorization_header():
    client = app.test_client()
    resp = client.get("/predict/device_abc123")
    assert resp.status_code == 401


def test_predict_endpoint_reports_backend_unreachable_honestly():
    client = app.test_client()
    with patch.object(app_module.requests, "get", side_effect=app_module.requests.RequestException("boom")):
        resp = client.get("/predict/device_abc123", headers={"Authorization": "Bearer x"})
        assert resp.status_code == 502


def test_health_endpoint():
    client = app.test_client()
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.get_json() == {"status": "ok"}
