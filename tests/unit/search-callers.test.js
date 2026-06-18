import { afterEach, describe, expect, it } from "vitest";
import { buildSearchRequest } from "../../open-sse/handlers/search/callers.js";
import searxng from "../../open-sse/providers/registry/searxng.js";

const baseParams = {
  query: "test query",
  searchType: "web",
  maxResults: 5,
};

afterEach(() => {
  delete process.env.SEARXNG_BASE_URL;
});

describe("SearXNG search request builder", () => {
  it("uses Docker service DNS instead of localhost by default", () => {
    const { url } = buildSearchRequest({ id: "searxng", ...searxng.searchConfig }, baseParams);

    expect(url).toContain("http://searxng:8080/search?");
    expect(url).toContain("q=test+query");
    expect(url).toContain("format=json");
  });

  it("allows SEARXNG_BASE_URL to override the deployed service URL", () => {
    process.env.SEARXNG_BASE_URL = "http://custom-searxng:8080";

    const { url } = buildSearchRequest({ id: "searxng", ...searxng.searchConfig }, baseParams);

    expect(url).toContain("http://custom-searxng:8080/search?");
  });

  it("keeps request provider_options.baseUrl as highest priority override", () => {
    process.env.SEARXNG_BASE_URL = "http://custom-searxng:8080";

    const { url } = buildSearchRequest(
      { id: "searxng", ...searxng.searchConfig },
      { ...baseParams, providerOptions: { baseUrl: "http://request-searxng:8080/search" } }
    );

    expect(url).toContain("http://request-searxng:8080/search?");
  });
});
