import { parseDelimited } from "../csv";
import type { IntegrationConfig } from "../types";
import type {
  ConnectionTestResult,
  FetchOptions,
  FetchPage,
  IntegrationProvider,
  ProviderCapabilities,
} from "./provider";
import { UNSUPPORTED } from "./provider";

/**
 * File-based integration.
 *
 * ## Why this is a first-class provider and not a fallback
 *
 * "Do not assume every external system has a modern API." A great many do
 * not. The fee software a college has run since 2009 exports an Excel file; a
 * board-mandated student register arrives as a CSV on a shared drive; a
 * biometric device writes a punch log to a USB stick. For those institutions
 * this is not a degraded path, it is *the* path, and treating it as a
 * second-class citizen would mean the platform works best for the schools
 * that needed it least.
 *
 * So a CSV connection is a real connection: it has a name, a status, a field
 * mapping, a last-sync time and an error history, exactly like a REST one.
 * What it does not have is a `testConnection` or a schedule, because there is
 * nothing to reach and nothing to poll — and it says so through its
 * capabilities rather than by failing when asked.
 *
 * ## Incremental
 *
 * `incremental: false`. Every upload is the whole file. The importer's
 * duplicate detection is what makes re-uploading the same file harmless — see
 * import.ts — rather than a watermark the file cannot carry.
 */

const CAPABILITIES: ProviderCapabilities = {
  testConnection: false,
  pull: false,
  push: true,
  incremental: false,
  scheduled: false,
  resources: ["students", "enrollments", "attendance"],
};

export class CsvProvider implements IntegrationProvider {
  readonly kind = "csv" as const;
  readonly label = "CSV / Excel upload";
  readonly capabilities = CAPABILITIES;

  validateConfig(config: IntegrationConfig): string[] {
    const problems: string[] = [];
    const delimiter = config.delimiter;
    if (delimiter !== undefined && delimiter.length !== 1) {
      problems.push("Delimiter must be a single character, e.g. `,` or `;` or a tab.");
    }
    return problems;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return UNSUPPORTED;
  }

  /**
   * There is nothing to fetch — a file arrives, it is not collected.
   *
   * Declining explicitly, rather than omitting the method, so the failure is
   * a clear sentence in a log rather than `provider.fetch is not a function`
   * from somewhere three layers up.
   */
  async fetch(_config: IntegrationConfig, options: FetchOptions): Promise<FetchPage> {
    throw new Error(
      `A CSV integration cannot pull ${options.resource}: upload a file through the Integration Center instead.`,
    );
  }

  /** What a CSV connection does instead of fetching: read an uploaded file. */
  read(config: IntegrationConfig, text: string): FetchPage {
    const parsed = parseDelimited(text, config.delimiter);
    return { rows: parsed.rows, nextCursor: null };
  }
}
