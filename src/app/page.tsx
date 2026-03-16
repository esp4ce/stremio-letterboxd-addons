import TransitionLink from "./components/TransitionLink";


const FEATURES = [
  "Watchlist & liked films",
  "Diary & friends activity",
  "Any public list by URL",
  "Popular & Top 250",
  "Ratings on posters",
  "Rate, like & manage from Stremio",
  "Sort, shuffle & filter",
  "All platforms",
];

export default function Home() {
  return (
    <div className="fixed inset-0 flex h-[100dvh] w-screen cursor-default flex-col bg-[#0a0a0a] text-white sm:h-screen sm:items-center sm:justify-center">
      <div className="flex min-h-0 w-full max-w-7xl flex-1 flex-col items-center justify-center overflow-y-auto px-4 sm:mx-auto sm:-mt-16 sm:h-full sm:flex-none sm:overflow-visible">
        <h1 className="mt-10 text-center text-2xl font-semibold tracking-tight text-white sm:mt-0 sm:text-5xl lg:text-6xl xl:text-7xl">
          Your Letterboxd. Inside Stremio.
        </h1>

        <p className="mt-4 text-center text-xl font-light text-zinc-400 sm:mt-6 sm:text-2xl">
          Free unofficial addon for all platforms.
        </p>

        <div className="mx-auto mt-6 w-full max-w-5xl max-h-[28vh] overflow-y-auto sm:mt-12 sm:max-h-none sm:overflow-visible config-scroll">
          <ul className="mx-auto grid w-full gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((feature) => (
              <li
                key={feature}
                className="flex items-center gap-3 rounded-xl bg-zinc-900/50 p-3 sm:p-4"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-sm text-zinc-300">
                  ✓
                </span>
                <span className="text-base font-light text-zinc-200">
                  {feature}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-6 flex flex-col items-center gap-2 text-center text-sm font-light text-zinc-500 sm:mt-10">
          <span>
            Use{" "}
            <a
              href="https://stremio-addon-manager.vercel.app/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 underline decoration-zinc-700 underline-offset-2 transition-colors hover:text-zinc-200"
            >
              Stremio Addon Manager
            </a>{" "}
            for the best experience.
          </span>
          <span>
            <TransitionLink
              href="/faq"
              direction="up"
              className="text-zinc-400 underline decoration-zinc-700 underline-offset-2 transition-colors hover:text-zinc-200"
            >
              FAQ
            </TransitionLink>
            {" "} for common questions.
          </span>
        </div>
      </div>

      <div className="flex shrink-0 justify-center py-6 sm:absolute sm:bottom-12">
        <TransitionLink
          href="/configure"
          direction="up"
          className="flex h-12 w-12 items-center justify-center rounded-full bg-white transition-all hover:scale-110 hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-[#0a0a0a]"
          ariaLabel="Continue to configuration"
        >
          <svg
            className="h-6 w-6 text-black"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 14l-7 7m0 0l-7-7m7 7V3"
            />
          </svg>
        </TransitionLink>
      </div>
    </div>
  );
}
