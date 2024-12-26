import { Request, Response } from "express";
import {
  Document,
  RequestWithAuth,
  ExtractRequest,
  extractRequestSchema,
  ExtractResponse,
  MapDocument,
  scrapeOptions,
  URLTrace,
} from "./types";
// import { Document } from "../../lib/entities";
import Redis from "ioredis";
import { configDotenv } from "dotenv";
import { performRanking } from "../../lib/ranker";
import { billTeam } from "../../services/billing/credit_billing";
import { logJob } from "../../services/logging/log_job";
import { logger } from "../../lib/logger";
import { getScrapeQueue } from "../../services/queue-service";
import { waitForJob } from "../../services/queue-jobs";
import { addScrapeJob } from "../../services/queue-jobs";
import { PlanType } from "../../types";
import { getJobPriority } from "../../lib/job-priority";
import { generateOpenAICompletions } from "../../scraper/scrapeURL/transformers/llmExtract";
import { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist";
import { getMapResults } from "./map";
import { buildDocument } from "../../lib/extract/build-document";
import { generateBasicCompletion } from "../../lib/LLM-extraction";
import { buildRefrasedPrompt } from "../../lib/extract/build-prompts";
import { removeDuplicateUrls } from "../../lib/validateUrl";

configDotenv();
const redis = new Redis(process.env.REDIS_URL!);

const MAX_EXTRACT_LIMIT = 100;
const MAX_RANKING_LIMIT = 10;
const INITIAL_SCORE_THRESHOLD = 0.75;
const FALLBACK_SCORE_THRESHOLD = 0.5;
const MIN_REQUIRED_LINKS = 1;

/**
 * Extracts data from the provided URLs based on the request parameters.
 * Currently in beta.
 * @param req - The request object containing authentication and extraction details.
 * @param res - The response object to send the extraction results.
 * @returns A promise that resolves when the extraction process is complete.
 */
export async function extractController(
  req: RequestWithAuth<{}, ExtractResponse, ExtractRequest>,
  res: Response<ExtractResponse>,
) {
  const selfHosted = process.env.USE_DB_AUTHENTICATION !== "true";

  req.body = extractRequestSchema.parse(req.body);

  const id = crypto.randomUUID();
  let links: string[] = [];
  let docs: Document[] = [];
  const earlyReturn = false;
  const urlTraces: URLTrace[] = [];

  // Process all URLs in parallel
  const urlPromises = req.body.urls.map(async (url) => {
    const trace: URLTrace = {
      url,
      status: 'mapped',
      timing: {
        discoveredAt: new Date().toISOString(),
      },
    };
    urlTraces.push(trace);

    if (url.includes("/*") || req.body.allowExternalLinks) {
      // Handle glob pattern URLs
      const baseUrl = url.replace("/*", "");
      const allowExternalLinks = req.body.allowExternalLinks;
      let urlWithoutWww = baseUrl.replace("www.", "");

      let rephrasedPrompt = req.body.prompt;
      if (req.body.prompt) {
        rephrasedPrompt =
          (await generateBasicCompletion(
            buildRefrasedPrompt(req.body.prompt, baseUrl),
          )) ?? req.body.prompt;
      }

      try {
        const mapResults = await getMapResults({
          url: baseUrl,
          search: rephrasedPrompt,
          teamId: req.auth.team_id,
          plan: req.auth.plan,
          allowExternalLinks,
          origin: req.body.origin,
          limit: req.body.limit,
          ignoreSitemap: false,
          includeMetadata: true,
          includeSubdomains: req.body.includeSubdomains,
        });

        let mappedLinks = mapResults.mapResults as MapDocument[];

        // Remove duplicates between mapResults.links and mappedLinks
        const allUrls = [...mappedLinks.map((m) => m.url), ...mapResults.links];
        const uniqueUrls = removeDuplicateUrls(allUrls);

        // Track all discovered URLs
        uniqueUrls.forEach(discoveredUrl => {
          if (!urlTraces.some(t => t.url === discoveredUrl)) {
            urlTraces.push({
              url: discoveredUrl,
              status: 'mapped',
              timing: {
                discoveredAt: new Date().toISOString(),
              },
              usedInCompletion: false, // Default to false, will update if used
            });
          }
        });

        // Only add URLs from mapResults.links that aren't already in mappedLinks
        const existingUrls = new Set(mappedLinks.map((m) => m.url));
        const newUrls = uniqueUrls.filter((url) => !existingUrls.has(url));

        mappedLinks = [
          ...mappedLinks,
          ...newUrls.map((url) => ({ url, title: "", description: "" })),
        ];

        if (mappedLinks.length === 0) {
          mappedLinks = [{ url: baseUrl, title: "", description: "" }];
        }

        // Limit number of links to MAX_EXTRACT_LIMIT
        mappedLinks = mappedLinks.slice(0, MAX_EXTRACT_LIMIT);

        let mappedLinksRerank = mappedLinks.map(
          (x) =>
            `url: ${x.url}, title: ${x.title}, description: ${x.description}`,
        );

        if (req.body.prompt) {
          let searchQuery =
            req.body.prompt && allowExternalLinks
              ? `${req.body.prompt} ${urlWithoutWww}`
              : req.body.prompt
                ? `${req.body.prompt} site:${urlWithoutWww}`
                : `site:${urlWithoutWww}`;
          // Get similarity scores between the search query and each link's context
          const linksAndScores = await performRanking(
            mappedLinksRerank,
            mappedLinks.map((l) => l.url),
            searchQuery,
          );

          // First try with high threshold
          let filteredLinks = filterAndProcessLinks(
            mappedLinks,
            linksAndScores,
            INITIAL_SCORE_THRESHOLD,
          );

          // If we don't have enough high-quality links, try with lower threshold
          if (filteredLinks.length < MIN_REQUIRED_LINKS) {
            logger.info(
              `Only found ${filteredLinks.length} links with score > ${INITIAL_SCORE_THRESHOLD}. Trying lower threshold...`,
            );
            filteredLinks = filterAndProcessLinks(
              mappedLinks,
              linksAndScores,
              FALLBACK_SCORE_THRESHOLD,
            );

            if (filteredLinks.length === 0) {
              // If still no results, take top N results regardless of score
              logger.warn(
                `No links found with score > ${FALLBACK_SCORE_THRESHOLD}. Taking top ${MIN_REQUIRED_LINKS} results.`,
              );
              filteredLinks = linksAndScores
                .sort((a, b) => b.score - a.score)
                .slice(0, MIN_REQUIRED_LINKS)
                .map((x) => mappedLinks.find((link) => link.url === x.link))
                .filter(
                  (x): x is MapDocument =>
                    x !== undefined &&
                    x.url !== undefined &&
                    !isUrlBlocked(x.url),
                );
            }
          }

          // Update URL traces with relevance scores and mark filtered out URLs
          linksAndScores.forEach((score) => {
            const trace = urlTraces.find((t) => t.url === score.link);
            if (trace) {
              trace.relevanceScore = score.score;
              // If URL didn't make it through filtering, mark it as filtered out
              if (!filteredLinks.some(link => link.url === score.link)) {
                trace.warning = `Relevance score ${score.score} below threshold`;
                trace.usedInCompletion = false;
              }
            }
          });

          mappedLinks = filteredLinks.slice(0, MAX_RANKING_LIMIT);
          
          // Mark URLs that will be used in completion
          mappedLinks.forEach(link => {
            const trace = urlTraces.find(t => t.url === link.url);
            if (trace) {
              trace.usedInCompletion = true;
            }
          });

          // Mark URLs that were dropped due to ranking limit
          filteredLinks.slice(MAX_RANKING_LIMIT).forEach(link => {
            const trace = urlTraces.find(t => t.url === link.url);
            if (trace) {
              trace.warning = 'Excluded due to ranking limit';
              trace.usedInCompletion = false;
            }
          });
        }

        return mappedLinks.map((x) => x.url);
      } catch (error) {
        trace.status = 'error';
        trace.error = error.message;
        trace.usedInCompletion = false;
        return [];
      }
    } else {
      // Handle direct URLs without glob pattern
      if (!isUrlBlocked(url)) {
        trace.usedInCompletion = true;
        return [url];
      }
      trace.status = 'error';
      trace.error = 'URL is blocked';
      trace.usedInCompletion = false;
      return [];
    }
  });

  // Wait for all URL processing to complete and flatten results
  const processedUrls = await Promise.all(urlPromises);
  const flattenedUrls = processedUrls.flat().filter((url) => url);
  links.push(...flattenedUrls);

  if (links.length === 0) {
    return res.status(400).json({
      success: false,
      error:
        "No valid URLs found to scrape. Try adjusting your search criteria or including more URLs.",
      urlTrace: urlTraces,
    });
  }

  // Scrape all links in parallel with retries
  const scrapePromises = links.map(async (url) => {
    const trace = urlTraces.find((t) => t.url === url);
    if (trace) {
      trace.status = 'scraped';
      trace.timing.scrapedAt = new Date().toISOString();
    }

    const origin = req.body.origin || "api";
    const timeout = Math.floor((req.body.timeout || 40000) * 0.7) || 30000;
    const jobId = crypto.randomUUID();

    const jobPriority = await getJobPriority({
      plan: req.auth.plan as PlanType,
      team_id: req.auth.team_id,
      basePriority: 10,
    });

    try {
      await addScrapeJob(
        {
          url,
          mode: "single_urls",
          team_id: req.auth.team_id,
          scrapeOptions: scrapeOptions.parse({}),
          internalOptions: {},
          plan: req.auth.plan!,
          origin,
          is_scrape: true,
        },
        {},
        jobId,
        jobPriority,
      );

      const doc = await waitForJob<Document>(jobId, timeout);
      await getScrapeQueue().remove(jobId);

      if (trace) {
        trace.timing.completedAt = new Date().toISOString();
        trace.contentStats = {
          rawContentLength: doc.markdown?.length || 0,
          processedContentLength: doc.markdown?.length || 0,
          tokensUsed: 0, // Will be updated after LLM processing
        };
      }

      if (earlyReturn) {
        return null;
      }
      return doc;
    } catch (e) {
      logger.error(`Error in extractController: ${e}`);
      if (trace) {
        trace.status = 'error';
        trace.error = e.message;
      }
      return null;
    }
  });

  try {
    const results = await Promise.all(scrapePromises);
    docs.push(...results.filter((doc) => doc !== null).map((x) => x!));
  } catch (e) {
    return res.status(e.status).json({
      success: false,
      error: e.error,
      urlTrace: urlTraces,
    });
  }

  const completions = await generateOpenAICompletions(
    logger.child({ method: "extractController/generateOpenAICompletions" }),
    {
      mode: "llm",
      systemPrompt:
        (req.body.systemPrompt ? `${req.body.systemPrompt}\n` : "") +
        "Always prioritize using the provided content to answer the question. Do not make up an answer. Be concise and follow the schema always if provided. Here are the urls the user provided of which he wants to extract information from: " +
        links.join(", "),
      prompt: req.body.prompt,
      schema: req.body.schema,
    },
    docs.map((x) => buildDocument(x)).join("\n"),
    undefined,
    true,
  );

  // Update token usage in URL traces
  if (completions.numTokens) {
    // Distribute tokens proportionally based on content length
    const totalLength = docs.reduce((sum, doc) => sum + (doc.markdown?.length || 0), 0);
    docs.forEach((doc) => {
      if (doc.metadata?.sourceURL) {
        const trace = urlTraces.find((t) => t.url === doc.metadata.sourceURL);
        if (trace && trace.contentStats) {
          trace.contentStats.tokensUsed = Math.floor(
            ((doc.markdown?.length || 0) / totalLength) * completions.numTokens
          );
        }
      }
    });
  }

  // TODO: change this later
  // While on beta, we're billing 5 credits per link discovered/scraped.
  billTeam(req.auth.team_id, req.acuc?.sub_id, links.length * 5).catch(
    (error) => {
      logger.error(
        `Failed to bill team ${req.auth.team_id} for ${links.length * 5} credits: ${error}`,
      );
    },
  );

  let data = completions.extract ?? {};
  let warning = completions.warning;

  logJob({
    job_id: id,
    success: true,
    message: "Extract completed",
    num_docs: 1,
    docs: data,
    time_taken: (new Date().getTime() - Date.now()) / 1000,
    team_id: req.auth.team_id,
    mode: "extract",
    url: req.body.urls.join(", "),
    scrapeOptions: req.body,
    origin: req.body.origin ?? "api",
    num_tokens: completions.numTokens ?? 0,
  });

  return res.status(200).json({
    success: true,
    data: data,
    scrape_id: id,
    warning: warning,
    urlTrace: urlTraces,
  });
}

/**
 * Filters links based on their similarity score to the search query.
 * @param mappedLinks - The list of mapped links to filter.
 * @param linksAndScores - The list of links and their similarity scores.
 * @param threshold - The score threshold to filter by.
 * @returns The filtered list of links.
 */
function filterAndProcessLinks(
  mappedLinks: MapDocument[],
  linksAndScores: {
    link: string;
    linkWithContext: string;
    score: number;
    originalIndex: number;
  }[],
  threshold: number,
): MapDocument[] {
  return linksAndScores
    .filter((x) => x.score > threshold)
    .map((x) => mappedLinks.find((link) => link.url === x.link))
    .filter(
      (x): x is MapDocument =>
        x !== undefined && x.url !== undefined && !isUrlBlocked(x.url),
    );
}
