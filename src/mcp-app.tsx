import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseSalesToolResult, type SalesToolResult } from "./sales.js";
import "./mcp-app.css";

type ViewState = "waiting" | "loading" | "ready" | "error";

function extractTextContent(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }

  for (const block of content) {
    if (typeof block !== "object" || block === null) {
      continue;
    }

    const candidate = block as Record<string, unknown>;
    if (candidate.type === "text" && typeof candidate.text === "string") {
      return candidate.text;
    }
  }

  return null;
}

function formatUpdatedAt(generatedAt: string): string {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) {
    return generatedAt;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function LoadingCards(): JSX.Element {
  return (
    <div className="sales-carousel" aria-hidden="true">
      {Array.from({ length: 3 }).map((_, index) => (
        <article className="sale-card sale-card-skeleton" key={`loading-${index}`}>
          <div className="sale-image shimmer" />
          <div className="sale-content">
            <div className="shimmer sale-line sale-line-title" />
            <div className="sale-tags">
              <span className="shimmer sale-tag-skeleton" />
              <span className="shimmer sale-tag-skeleton" />
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

function App(): JSX.Element {
  const [hostContext, setHostContext] = useState<McpUiHostContext | null>(null);
  const [result, setResult] = useState<SalesToolResult | null>(null);
  const [viewState, setViewState] = useState<ViewState>("waiting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const carouselRef = useRef<HTMLDivElement | null>(null);

  const { app, isConnected, error } = useApp({
    appInfo: {
      name: "choose-current-sales-ui",
      version: "0.1.0",
    },
    capabilities: {},
    onAppCreated: (mcpApp) => {
      mcpApp.ontoolinput = () => {
        setViewState("loading");
        setErrorMessage(null);
      };

      mcpApp.ontoolresult = (toolResult) => {
        if (toolResult.isError) {
          setViewState("error");
          setResult(null);
          setErrorMessage(
            extractTextContent(toolResult.content) ??
              "Failed to load current sales.",
          );
          return;
        }

        const parsed = parseSalesToolResult(toolResult.structuredContent);

        if (!parsed) {
          setViewState("error");
          setResult(null);
          setErrorMessage("Received an unexpected payload from the tool.");
          return;
        }

        setResult(parsed);
        setViewState("ready");
        setErrorMessage(null);
      };

      mcpApp.ontoolcancelled = (params) => {
        setViewState("error");
        setResult(null);
        setErrorMessage(
          params.reason ? `Request cancelled: ${params.reason}` : "Request cancelled.",
        );
      };

      mcpApp.onhostcontextchanged = (nextContext) => {
        setHostContext((previous) => ({ ...(previous ?? {}), ...nextContext }));
      };
    },
  });

  const activeContext = useMemo(
    () => hostContext ?? app?.getHostContext() ?? null,
    [app, hostContext],
  );

  useHostStyles(app, activeContext);

  useEffect(() => {
    const insets = activeContext?.safeAreaInsets;
    if (!insets) {
      document.body.style.padding = "";
      return;
    }

    document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
  }, [activeContext]);

  const sales = result?.sales ?? [];
  const hasSales = sales.length > 0;

  const subtitle = useMemo(() => {
    if (viewState === "error" && errorMessage) {
      return errorMessage;
    }

    if (viewState === "ready" && result) {
      return `Updated ${formatUpdatedAt(result.generatedAt)}`;
    }

    if (viewState === "loading") {
      return "Fetching live sales...";
    }

    return "Waiting for tool data...";
  }, [errorMessage, result, viewState]);

  const scrollCarousel = (offset: number): void => {
    carouselRef.current?.scrollBy({ left: offset, behavior: "smooth" });
  };

  if (error) {
    return (
      <div className="sales-app">
        <div className="state-panel error">
          <h2>Unable to initialize app</h2>
          <p>{error.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="sales-app">
      <header className="sales-header">
        <div>
          <h1>Live Sales</h1>
          <p>{isConnected ? subtitle : "Connecting to host..."}</p>
        </div>
        <div className="header-controls">
          <span className="count-pill">
            {result ? `${result.count} active` : "-- active"}
          </span>
          <div className="nav-controls" role="group" aria-label="Carousel navigation">
            <button
              type="button"
              className="nav-btn"
              onClick={() => scrollCarousel(-320)}
              disabled={!hasSales}
            >
              &larr;
            </button>
            <button
              type="button"
              className="nav-btn"
              onClick={() => scrollCarousel(320)}
              disabled={!hasSales}
            >
              &rarr;
            </button>
          </div>
        </div>
      </header>

      {viewState === "loading" || viewState === "waiting" ? (
        <LoadingCards />
      ) : null}

      {viewState === "error" ? (
        <div className="state-panel error">
          <h2>Could not load live sales</h2>
          <p>{errorMessage ?? "Please try running the tool again."}</p>
        </div>
      ) : null}

      {viewState === "ready" && !hasSales ? (
        <div className="state-panel">
          <h2>No live sales right now</h2>
          <p>Try again in a moment to refresh the feed.</p>
        </div>
      ) : null}

      {viewState === "ready" && hasSales ? (
        <div className="sales-carousel" ref={carouselRef}>
          {sales.map((sale) => (
            <article className="sale-card" key={sale.id}>
              <div className="sale-image">
                {sale.imageUrl ? (
                  <img src={sale.imageUrl} alt={sale.name} loading="lazy" />
                ) : (
                  <div className="image-fallback">No image</div>
                )}
              </div>
              <div className="sale-content">
                <h2>{sale.name}</h2>
                <div className="sale-tags">
                  {(sale.categories.length > 0 ? sale.categories : ["General"]).map(
                    (category) => (
                      <span className="sale-tag" key={`${sale.id}-${category}`}>
                        {category}
                      </span>
                    ),
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing #root element.");
}

createRoot(rootElement).render(<App />);
