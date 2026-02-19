import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";

export async function GET(request: Request) {
  try {
    const filePath = path.join(process.cwd(), "public", "risk_scores.json");
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw);

    const { searchParams } = new URL(request.url);
    const asset = searchParams.get("asset");

    if (asset && data.assets?.[asset.toUpperCase()]) {
      return NextResponse.json(data.assets[asset.toUpperCase()]);
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      {
        updated_at: null,
        engine_version: "5.0",
        assets: {
          BTC: { asset_id: "BTC", name: "Bitcoin", risk_score: 50, price: 67000, status: "error" },
          ETH: { asset_id: "ETH", name: "Ethereum", risk_score: 50, price: 2000, status: "error" },
          SOL: { asset_id: "SOL", name: "Solana", risk_score: 50, price: 80, status: "error" },
          XRP: { asset_id: "XRP", name: "XRP", risk_score: 50, price: 1.4, status: "error" },
        },
      },
      { status: 500 },
    );
  }
}
