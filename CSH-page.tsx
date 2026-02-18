export default function Home() {
  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @keyframes fadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
          `,
        }}
      />
      <div
        className="flex min-h-screen flex-col items-center justify-center bg-[radial-gradient(ellipse_80%_50%_at_50%_50%,#0E2A47_0%,#0a1f35_70%,#061826_100%)] px-6"
      >
        <main className="max-w-2xl text-center animate-[fadeIn_0.8s_ease-out]">
  
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-[#F28C28]">
            CRYPTO SUPER HUB
          </p>
          <h1 className="text-4xl font-bold leading-tight text-white md:text-6xl">
            Digital Asset Risk Index
          </h1>
          <div
            className="mx-auto my-4 h-px w-16 bg-[#F28C28]"
            aria-hidden
          />
          <p className="mx-auto max-w-xl text-lg leading-relaxed text-white/80">
            A disciplined digital asset risk framework for investors.
          </p>
          <p className="mx-auto mt-4 text-sm tracking-wide text-white/60">
            Data-driven • Market-cycle aware • Objective
          </p>
        </main>
      </div>
    </>
  );
}
