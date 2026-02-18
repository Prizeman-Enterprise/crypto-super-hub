import { NextRequest, NextResponse } from "next/server";

// TODO: Wire this up to a real database + email provider (e.g. Nodemailer + SMTP).
// For now, this endpoint simply logs the payload server-side so the front-end
// flow is complete and can be swapped to a real implementation later.

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId, email, message, createdAt } = body ?? {};

    // Basic validation (non-empty message).
    if (!message || typeof message !== "string") {
      return NextResponse.json({ ok: false, error: "Message is required." }, { status: 400 });
    }

    // Stub persistence: log to server console. Replace with DB insert.
    // eslint-disable-next-line no-console
    console.log("[csh-support] New support message", {
      userId: userId ?? null,
      email: email ?? null,
      createdAt: createdAt ?? new Date().toISOString(),
      message,
    });

    // Stub email: in a real implementation, send an email to cryptosuperhub@gmail.com.
    // Example (pseudo):
    // await sendSupportEmail({ to: "cryptosuperhub@gmail.com", from: email, message, userId });

    return NextResponse.json({ ok: true });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[csh-support] Error handling support request", error);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}

