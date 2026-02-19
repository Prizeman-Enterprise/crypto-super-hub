"""
Cycle-Relative Risk Engine v2 — Multi-Asset (Binance)
======================================================
Computes daily 0–100 risk scores for BTC, ETH, SOL, XRP.

Model:
  - BTC: Expanding-window power-law regression (full 15yr history)
  - Alts: Rolling 4-year window regression (captures current cycle,
    prevents ancient low prices from inflating the trend line)
  - All: MAD-based z-score → sigmoid → EMA smoothing

Usage:
    python3 risk_engine.py

Output: ~/csh-cycle-index/public/risk_scores.json
"""

import numpy as np
import pandas as pd
import requests
import time
import json
import os
import sys
import warnings
from datetime import datetime, timedelta
from dataclasses import dataclass
from typing import Optional

warnings.filterwarnings("ignore")

# ──────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────

OUTPUT_DIR = os.path.expanduser("~/csh-cycle-index/public")
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "risk_scores.json")
LOG_FILE = os.path.expanduser("~/csh-cycle-index/risk_engine.log")


@dataclass
class AssetConfig:
    asset_id: str
    name: str
    genesis_date: str
    binance_symbol: str
    warm_up_days: int = 365
    sigmoid_k: float = 1.5
    smooth_span: int = 7
    mad_floor: float = 0.10
    clamp_min: float = 1.0
    clamp_max: float = 99.0
    regression_mode: str = "expanding"
    rolling_window_days: int = 1460
    norm_window_days: int = 0


ASSETS = [
    AssetConfig(
        asset_id="BTC",
        name="Bitcoin",
        genesis_date="2009-01-03",
        binance_symbol="BTCUSDT",
        warm_up_days=365,
        sigmoid_k=1.5,
        smooth_span=7,
        mad_floor=0.10,
        regression_mode="expanding",
        norm_window_days=0,
    ),
    AssetConfig(
        asset_id="ETH",
        name="Ethereum",
        genesis_date="2015-08-07",
        binance_symbol="ETHUSDT",
        warm_up_days=365,
        sigmoid_k=1.5,
        smooth_span=7,
        mad_floor=0.12,
        regression_mode="rolling",
        rolling_window_days=1460,
        norm_window_days=1460,
    ),
    AssetConfig(
        asset_id="SOL",
        name="Solana",
        genesis_date="2020-04-10",
        binance_symbol="SOLUSDT",
        warm_up_days=365,
        sigmoid_k=1.5,
        smooth_span=7,
        mad_floor=0.15,
        regression_mode="rolling",
        rolling_window_days=1460,
        norm_window_days=1460,
    ),
    AssetConfig(
        asset_id="XRP",
        name="XRP",
        genesis_date="2013-08-04",
        binance_symbol="XRPUSDT",
        warm_up_days=365,
        sigmoid_k=1.5,
        smooth_span=7,
        mad_floor=0.12,
        regression_mode="rolling",
        rolling_window_days=1460,
        norm_window_days=1460,
    ),
]


# ──────────────────────────────────────────────────────────────
# Pre-Binance historical prices
# ──────────────────────────────────────────────────────────────

PRE_BINANCE = {
    "BTC": {
        "2010-07-18": 0.05, "2010-08-01": 0.07, "2010-09-01": 0.06,
        "2010-10-01": 0.06, "2010-11-01": 0.22, "2010-12-01": 0.23,
        "2011-01-01": 0.30, "2011-02-01": 0.92, "2011-03-01": 0.87,
        "2011-04-01": 1.57, "2011-05-01": 8.17, "2011-06-01": 14.00,
        "2011-06-08": 29.60, "2011-07-01": 14.46, "2011-08-01": 11.00,
        "2011-09-01": 4.78, "2011-10-01": 3.20, "2011-11-01": 2.98,
        "2011-11-18": 2.22, "2011-12-01": 3.06,
        "2012-01-01": 5.27, "2012-02-01": 4.37, "2012-03-01": 4.94,
        "2012-04-01": 5.00, "2012-05-01": 5.09, "2012-06-01": 6.14,
        "2012-07-01": 6.78, "2012-08-01": 10.18, "2012-09-01": 11.98,
        "2012-10-01": 12.34, "2012-11-01": 12.05, "2012-12-01": 13.45,
        "2013-01-01": 13.30, "2013-02-01": 22.13, "2013-03-01": 34.46,
        "2013-04-01": 93.57, "2013-04-10": 196.00, "2013-05-01": 116.99,
        "2013-06-01": 128.16, "2013-07-01": 97.10, "2013-08-01": 107.60,
        "2013-09-01": 140.00, "2013-10-01": 135.30, "2013-11-01": 210.64,
        "2013-11-29": 1163.00, "2013-12-01": 946.92,
        "2014-01-01": 771.40, "2014-02-01": 829.56, "2014-03-01": 562.98,
        "2014-04-01": 443.34, "2014-05-01": 449.47, "2014-06-01": 628.51,
        "2014-07-01": 640.68, "2014-08-01": 522.25, "2014-09-01": 386.94,
        "2014-10-01": 338.32, "2014-11-01": 325.24, "2014-12-01": 378.64,
        "2015-01-01": 314.25, "2015-01-14": 178.10, "2015-02-01": 220.16,
        "2015-03-01": 254.28, "2015-04-01": 244.23, "2015-05-01": 236.17,
        "2015-06-01": 225.21, "2015-07-01": 259.30, "2015-08-01": 284.00,
        "2015-09-01": 230.60, "2015-10-01": 237.50, "2015-11-01": 329.61,
        "2015-12-01": 377.30,
        "2016-01-01": 430.72, "2016-02-01": 371.04, "2016-03-01": 413.65,
        "2016-04-01": 416.75, "2016-05-01": 448.48, "2016-06-01": 536.35,
        "2016-07-01": 676.97, "2016-08-01": 607.38, "2016-09-01": 604.84,
        "2016-10-01": 614.95, "2016-11-01": 731.23, "2016-12-01": 770.44,
        "2017-01-01": 963.66, "2017-02-01": 970.41, "2017-03-01": 1190.45,
        "2017-04-01": 1071.79, "2017-05-01": 1402.78, "2017-06-01": 2434.55,
        "2017-07-01": 2492.60, "2017-08-01": 2875.34,
    },
    "ETH": {
        "2015-08-07": 1.20, "2015-09-01": 1.12, "2015-10-01": 0.80,
        "2015-11-01": 0.98, "2015-12-01": 0.90,
        "2016-01-01": 0.95, "2016-02-01": 4.42, "2016-03-01": 10.18,
        "2016-04-01": 8.02, "2016-05-01": 11.58, "2016-06-01": 14.48,
        "2016-07-01": 10.56, "2016-08-01": 11.78, "2016-09-01": 12.80,
        "2016-10-01": 12.26, "2016-11-01": 10.73, "2016-12-01": 8.05,
        "2017-01-01": 8.17, "2017-02-01": 10.68, "2017-03-01": 16.60,
        "2017-04-01": 50.22, "2017-05-01": 84.27, "2017-06-01": 229.34,
        "2017-07-01": 262.80, "2017-08-01": 225.69,
    },
    "XRP": {
        "2013-08-04": 0.005, "2013-09-01": 0.005, "2013-10-01": 0.005,
        "2013-11-01": 0.014, "2013-12-01": 0.023,
        "2014-01-01": 0.021, "2014-02-01": 0.020, "2014-03-01": 0.018,
        "2014-04-01": 0.013, "2014-05-01": 0.014, "2014-06-01": 0.008,
        "2014-07-01": 0.007, "2014-08-01": 0.006, "2014-09-01": 0.005,
        "2014-10-01": 0.004, "2014-11-01": 0.003, "2014-12-01": 0.003,
        "2015-01-01": 0.017, "2015-02-01": 0.014, "2015-03-01": 0.014,
        "2015-04-01": 0.013, "2015-05-01": 0.008, "2015-06-01": 0.008,
        "2015-07-01": 0.009, "2015-08-01": 0.008, "2015-09-01": 0.007,
        "2015-10-01": 0.005, "2015-11-01": 0.004, "2015-12-01": 0.006,
        "2016-01-01": 0.006, "2016-02-01": 0.007, "2016-03-01": 0.008,
        "2016-04-01": 0.007, "2016-05-01": 0.008, "2016-06-01": 0.007,
        "2016-07-01": 0.007, "2016-08-01": 0.006, "2016-09-01": 0.006,
        "2016-10-01": 0.007, "2016-11-01": 0.008, "2016-12-01": 0.007,
        "2017-01-01": 0.006, "2017-02-01": 0.006, "2017-03-01": 0.007,
        "2017-04-01": 0.033, "2017-05-01": 0.177, "2017-06-01": 0.268,
        "2017-07-01": 0.258, "2017-08-01": 0.169,
    },
}


def get_pre_binance_prices(asset_id):
    if asset_id not in PRE_BINANCE:
        return None
    data = PRE_BINANCE[asset_id]
    dates = [pd.Timestamp(d) for d in data.keys()]
    prices = list(data.values())
    series = pd.Series(prices, index=dates, name="price").sort_index()
    return series.resample("D").ffill()


# ──────────────────────────────────────────────────────────────
# Binance Data Fetcher
# ──────────────────────────────────────────────────────────────

def fetch_binance_prices(symbol, start_date):
    all_candles = []
    start_ts = int(pd.Timestamp(start_date).timestamp() * 1000)
    end_ts = int(datetime.utcnow().timestamp() * 1000)
    url = "https://api.binance.com/api/v3/klines"
    batch = 0

    while start_ts < end_ts:
        batch += 1
        params = {
            "symbol": symbol,
            "interval": "1d",
            "startTime": start_ts,
            "limit": 1000,
        }
        try:
            resp = requests.get(url, params=params, timeout=30)
            resp.raise_for_status()
            candles = resp.json()
        except requests.exceptions.RequestException as e:
            log("  Error batch {}: {}".format(batch, e))
            time.sleep(5)
            continue

        if not candles:
            break

        all_candles.extend(candles)
        start_ts = candles[-1][6] + 1
        time.sleep(0.2)

    if not all_candles:
        raise ValueError("No data returned for {}".format(symbol))

    df = pd.DataFrame(all_candles)
    df["date"] = pd.to_datetime(df[0], unit="ms").dt.normalize()
    df["price"] = df[4].astype(float)
    df = df[["date", "price"]].drop_duplicates(subset=["date"], keep="last")
    df = df.set_index("date").sort_index()

    return df["price"]


def fetch_full_prices(config):
    pre = get_pre_binance_prices(config.asset_id)

    binance_starts = {
        "BTCUSDT": "2017-08-17",
        "ETHUSDT": "2017-08-17",
        "SOLUSDT": "2020-04-10",
        "XRPUSDT": "2018-01-01",
    }
    start = binance_starts.get(config.binance_symbol, "2020-01-01")

    log("  Fetching {} from Binance (from {})...".format(config.binance_symbol, start))
    binance = fetch_binance_prices(config.binance_symbol, start)
    log("  Got {} candles".format(len(binance)))

    if pre is not None and len(pre) > 0:
        cutoff = binance.index[0]
        pre_only = pre[pre.index < cutoff]
        combined = pd.concat([pre_only, binance]).sort_index()
        combined = combined[~combined.index.duplicated(keep="last")]
        log("  Combined: {} days (pre-Binance: {}, Binance: {})".format(
            len(combined), len(pre_only), len(binance)))
    else:
        combined = binance
        log("  Total: {} days".format(len(combined)))

    return combined


# ──────────────────────────────────────────────────────────────
# Risk Score Computation
# ──────────────────────────────────────────────────────────────

def compute_risk_scores(prices, config):
    """
    Compute daily risk scores.

    Two regression modes:
      - "expanding": OLS on all data from day 1 to current day.
        Best for BTC with 15+ years of stable power-law growth.
      - "rolling": OLS on last N days only.
        Better for alts where ancient low prices distort the trend.
    """

    df = pd.DataFrame({
        "date": prices.index,
        "price": prices.values,
    }).reset_index(drop=True)

    genesis = pd.Timestamp(config.genesis_date)
    df["days_since_genesis"] = (df["date"] - genesis).dt.days.astype(float)
    df = df[df["days_since_genesis"] > 0].copy()
    df = df[df["price"] > 0].copy()
    df = df.reset_index(drop=True)

    df["log_price"] = np.log(df["price"])
    df["log_days"] = np.log(df["days_since_genesis"])

    n = len(df)
    df["trend_value"] = np.nan
    df["residual"] = np.nan
    df["z_score"] = np.nan
    df["raw_score"] = np.nan
    df["smoothed_score"] = np.nan
    df["risk_score"] = np.nan

    alpha = 2.0 / (config.smooth_span + 1)
    prev_smoothed = 50.0
    all_residuals = []

    log_days = df["log_days"].values
    log_price = df["log_price"].values

    for i in range(n):
        # Determine regression window
        if config.regression_mode == "rolling" and config.rolling_window_days > 0:
            win_start = max(0, i - config.rolling_window_days + 1)
            if (i - win_start + 1) < config.warm_up_days:
                continue
        else:
            win_start = 0
            if (i + 1) < config.warm_up_days:
                continue

        # OLS on the window
        x_win = log_days[win_start:i+1]
        y_win = log_price[win_start:i+1]

        x_mean = np.mean(x_win)
        y_mean = np.mean(y_win)
        ss_xx = np.sum((x_win - x_mean) ** 2)
        ss_xy = np.sum((x_win - x_mean) * (y_win - y_mean))

        if abs(ss_xx) < 1e-12:
            continue

        b = ss_xy / ss_xx
        a = y_mean - b * x_mean

        xi = log_days[i]
        trend = a + b * xi
        residual = log_price[i] - trend

        df.iat[i, df.columns.get_loc("trend_value")] = np.exp(trend)
        df.iat[i, df.columns.get_loc("residual")] = residual
        all_residuals.append(residual)

        # Normalization window
        if config.norm_window_days > 0 and len(all_residuals) > config.norm_window_days:
            r_arr = np.array(all_residuals[-config.norm_window_days:])
        else:
            r_arr = np.array(all_residuals)

        med = np.median(r_arr)
        mad = np.median(np.abs(r_arr - med))
        effective_mad = max(mad, config.mad_floor)
        z = (residual - med) / effective_mad

        df.iat[i, df.columns.get_loc("z_score")] = z

        raw = 100.0 / (1.0 + np.exp(-config.sigmoid_k * z))
        df.iat[i, df.columns.get_loc("raw_score")] = raw

        smoothed = alpha * raw + (1.0 - alpha) * prev_smoothed
        df.iat[i, df.columns.get_loc("smoothed_score")] = smoothed
        prev_smoothed = smoothed

        final = max(config.clamp_min, min(config.clamp_max, smoothed))
        df.iat[i, df.columns.get_loc("risk_score")] = final

    return df


# ──────────────────────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────────────────────

def log(msg):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = "[{}] {}".format(timestamp, msg)
    print(line)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ──────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────

def main():
    log("=" * 60)
    log("Risk Engine v2 — Multi-Asset (rolling window for alts)")
    log("=" * 60)

    results = {}
    errors = []

    for config in ASSETS:
        log("")
        log("--- {} ({}) [{}] ---".format(
            config.name, config.asset_id, config.regression_mode))

        try:
            prices = fetch_full_prices(config)
            log("  Price range: ${:,.4f} to ${:,.2f}".format(
                prices.iloc[0], prices.iloc[-1]))

            df = compute_risk_scores(prices, config)
            valid = df.dropna(subset=["risk_score"])

            if valid.empty:
                log("  WARNING: No valid scores computed")
                errors.append(config.asset_id)
                continue

            latest = valid.iloc[-1]

            results[config.asset_id] = {
                "asset_id": config.asset_id,
                "name": config.name,
                "date": latest["date"].strftime("%Y-%m-%d"),
                "risk_score": round(float(latest["risk_score"]), 1),
                "price": round(float(latest["price"]), 2),
                "trend_value": round(float(latest["trend_value"]), 2),
                "components": {
                    "residual": round(float(latest["residual"]), 6),
                    "z_score": round(float(latest["z_score"]), 4),
                    "raw_score": round(float(latest["raw_score"]), 2),
                    "smoothed_score": round(float(latest["smoothed_score"]), 2),
                },
                "regression_mode": config.regression_mode,
                "history_days": len(valid),
                "status": "active",
            }

            log("  Score: {:.1f} | Price: ${:,.2f} | Trend: ${:,.2f}".format(
                latest["risk_score"], latest["price"], latest["trend_value"]))

            csv_dir = os.path.expanduser("~/csh-cycle-index/data")
            os.makedirs(csv_dir, exist_ok=True)
            csv_path = os.path.join(csv_dir, "{}_risk_history.csv".format(
                config.asset_id.lower()))
            export_cols = ["date", "price", "trend_value", "residual",
                           "z_score", "raw_score", "smoothed_score", "risk_score"]
            valid[export_cols].to_csv(csv_path, index=False)
            log("  Saved: {}".format(csv_path))

        except Exception as e:
            log("  ERROR: {}".format(e))
            errors.append(config.asset_id)

    # Build output JSON
    output = {
        "updated_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "engine_version": "2.0",
        "assets": results,
    }

    if "BTC" in results:
        btc = results["BTC"]
        output["asset_id"] = btc["asset_id"]
        output["date"] = btc["date"]
        output["risk_score"] = btc["risk_score"]
        output["price"] = btc["price"]
        output["trend_value"] = btc["trend_value"]
        output["components"] = btc["components"]

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(OUTPUT_FILE, "w") as f:
        json.dump(output, f, indent=2)
    log("")
    log("Output: {}".format(OUTPUT_FILE))

    old_json = os.path.join(OUTPUT_DIR, "btc_risk_latest.json")
    if "BTC" in results:
        with open(old_json, "w") as f:
            btc_out = dict(results["BTC"])
            btc_out["updated_at"] = output["updated_at"]
            json.dump(btc_out, f, indent=2)

    # Summary with comparison targets
    log("")
    log("=" * 60)
    log("  SUMMARY (v2)")
    log("=" * 60)
    log("  {:<5} {:>7} {:>7} {:>12} {:>12} {:<10}".format(
        "Asset", "Risk", "0-1", "Price", "Trend", "Mode"))
    log("  {} {} {} {} {} {}".format(
        "-" * 5, "-" * 7, "-" * 7, "-" * 12, "-" * 12, "-" * 10))
    for aid, data in results.items():
        log("  {:<5} {:>6.1f} {:>6.3f} ${:>10,.2f} ${:>10,.2f} {}".format(
            aid, data["risk_score"], data["risk_score"] / 100,
            data["price"], data["trend_value"],
            data["regression_mode"]))
    log("")
    log("  Compare with reference (Cowen 2026-02-19):")
    log("  BTC: 0.305 | ETH: 0.431 | SOL: 0.329 | XRP: 0.432")
    if errors:
        log("")
        log("  ERRORS: {}".format(", ".join(errors)))
    log("=" * 60)


if __name__ == "__main__":
    main()
