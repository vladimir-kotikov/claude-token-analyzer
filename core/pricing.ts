/** USD per token, by model. Extend as new models show up in transcripts. */
export interface ModelRates {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

const RATES_PER_MTOK: Record<string, ModelRates> = {
  "claude-sonnet-5": {
    input: 2.0,
    output: 10.0,
    cacheWrite5m: 2.5,
    cacheWrite1h: 4.0,
    cacheRead: 0.2,
  },
  "claude-sonnet-4-6": {
    input: 3.0,
    output: 15.0,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6.0,
    cacheRead: 0.3,
  },
  "claude-opus-5": {
    input: 5.0,
    output: 25.0,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10.0,
    cacheRead: 0.5,
  },
  "claude-haiku-4-5": {
    input: 1.0,
    output: 5.0,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2.0,
    cacheRead: 0.1,
  },
};

const FALLBACK_RATES = RATES_PER_MTOK["claude-sonnet-5"];

export function ratesForModel(model: string | undefined): ModelRates {
  if (model && RATES_PER_MTOK[model]) return RATES_PER_MTOK[model];
  return FALLBACK_RATES;
}

export interface TokenCounts {
  inputTokens: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  outputTokens: number;
}

export interface CostBreakdown {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  total: number;
}

export function costOf(model: string | undefined, t: TokenCounts): CostBreakdown {
  const r = ratesForModel(model);
  const input = (t.inputTokens * r.input) / 1e6;
  const cacheRead = (t.cacheRead * r.cacheRead) / 1e6;
  const cacheWrite5m = (t.cacheWrite5m * r.cacheWrite5m) / 1e6;
  const cacheWrite1h = (t.cacheWrite1h * r.cacheWrite1h) / 1e6;
  const output = (t.outputTokens * r.output) / 1e6;
  return {
    input,
    cacheRead,
    cacheWrite5m,
    cacheWrite1h,
    output,
    total: input + cacheRead + cacheWrite5m + cacheWrite1h + output,
  };
}
