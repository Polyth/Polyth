import type { MarketProvider } from "../providers.ts";
import type { MarketFiling } from "../types.ts";
import { createLimiter, fetchJson, numeric, record, text, valueAt, type FetchLike } from "./http.ts";

const TICKER_MAP_TTL_MS = 12 * 60 * 60_000;

export interface SecProviderOptions {
  userAgent: string;
  fetch?: FetchLike;
  now?: () => number;
}

interface SecCompany {
  cik: number;
  title?: string;
}

const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const value = (values: unknown[], index: number): unknown => values[index];

export function createSecProvider(options: SecProviderOptions): MarketProvider {
  const userAgent = options.userAgent.trim();
  if (!userAgent) throw new Error("SEC User-Agent is required");
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const limit = createLimiter(2);
  const headers = {
    "User-Agent": userAgent,
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
  };
  let companies = new Map<string, SecCompany>();
  let companiesLoadedAt = 0;
  let companiesPromise: Promise<Map<string, SecCompany>> | null = null;

  const loadCompanies = async (signal: AbortSignal): Promise<Map<string, SecCompany>> => {
    if (companies.size > 0 && now() - companiesLoadedAt < TICKER_MAP_TTL_MS) return companies;
    if (companiesPromise) return companiesPromise;
    companiesPromise = limit(async () => {
      const json = await fetchJson(
        fetchImpl,
        "https://www.sec.gov/files/company_tickers.json",
        { headers, signal },
        "sec tickers",
      );
      const root = record(json);
      if (!root) throw new Error("sec tickers: malformed response");
      const next = new Map<string, SecCompany>();
      for (const entry of Object.values(root)) {
        const row = record(entry);
        const ticker = text(row?.ticker)?.toUpperCase();
        const cik = numeric(row?.cik_str);
        if (!ticker || cik === undefined || !Number.isInteger(cik) || cik <= 0) continue;
        next.set(ticker, { cik, ...(text(row?.title) ? { title: text(row?.title) } : {}) });
      }
      if (next.size === 0) throw new Error("sec tickers: empty response");
      companies = next;
      companiesLoadedAt = now();
      return companies;
    });
    try {
      return await companiesPromise;
    } finally {
      companiesPromise = null;
    }
  };

  return {
    id: "sec",
    async filings(symbol, signal) {
      const company = (await loadCompanies(signal)).get(symbol);
      if (!company) throw new Error(`sec: no CIK mapping for ${symbol}`);
      const cik = String(company.cik).padStart(10, "0");
      const submission = await limit(() => fetchJson(
        fetchImpl,
        `https://data.sec.gov/submissions/CIK${cik}.json`,
        { headers, signal },
        "sec submissions",
      ));
      const recent = record(valueAt(submission, "filings", "recent"));
      if (!recent) throw new Error(`sec: no recent filings for ${symbol}`);

      const accessionNumbers = array(recent.accessionNumber);
      const filingDates = array(recent.filingDate);
      const reportDates = array(recent.reportDate);
      const forms = array(recent.form);
      const primaryDocuments = array(recent.primaryDocument);
      const descriptions = array(recent.primaryDocDescription);
      const companyName = text(valueAt(submission, "name")) ?? company.title;
      const cikPath = String(company.cik);
      const filings: MarketFiling[] = [];

      for (let index = 0; index < accessionNumbers.length; index += 1) {
        const accessionNumber = text(value(accessionNumbers, index));
        const filedAt = text(value(filingDates, index));
        const form = text(value(forms, index));
        if (!accessionNumber || !filedAt || !form) continue;
        const accessionPath = accessionNumber.replace(/-/g, "");
        const primaryDocument = text(value(primaryDocuments, index));
        const documentPath = primaryDocument ? `/${encodeURIComponent(primaryDocument)}` : "/";
        filings.push({
          symbol,
          cik,
          ...(companyName ? { companyName } : {}),
          form,
          filedAt,
          ...(text(value(reportDates, index)) ? { reportDate: text(value(reportDates, index)) } : {}),
          accessionNumber,
          ...(primaryDocument ? { primaryDocument } : {}),
          ...(text(value(descriptions, index)) ? { description: text(value(descriptions, index)) } : {}),
          url: `https://www.sec.gov/Archives/edgar/data/${cikPath}/${accessionPath}${documentPath}`,
          source: "sec",
        });
      }
      if (filings.length === 0) throw new Error(`sec: empty filings for ${symbol}`);
      return filings;
    },
  };
}
