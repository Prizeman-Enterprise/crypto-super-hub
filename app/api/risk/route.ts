import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";

/** Reads live BTC risk from public/btc_risk_latest.json. Returns 500 with fallback if file missing. */
export async function GET() {
  try {
    const filePath = path.join(process.cwd(), "public", "btc_risk_latest.json");
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as {
      asset_id?: string;
      date?: string;
      risk_score?: number;
      price?: number;
      trend_value?: number;
      components?: unknown;
      updated_at?: string;
    };
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { risk_score: 50, price: 67520.95, asset_id: "BTC", date: null, trend_value: null, components: null, updated_at: null },
      { status: 500 },
    );
  }
}
