import type {
  AggregatesResponse,
  ApiError,
  GeoResponse,
  InsightsResponse,
  MetaResponse,
  MoodReportInput,
  ReportAccepted,
  TrendsResponse,
} from '@shared/types';

/** Thrown for any non-2xx response. `status` is 0 for network failures. */
export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiRequestError(0, 'Network error — could not reach the server.');
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as ApiError;
      if (body && body.ok === false && typeof body.error === 'string') message = body.error;
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new ApiRequestError(res.status, message);
  }
  return (await res.json()) as T;
}

export function fetchAggregates(res: number, windowMins: number, at?: number): Promise<AggregatesResponse> {
  const params = new URLSearchParams({ res: String(res), windowMins: String(windowMins) });
  if (at !== undefined) params.set('at', String(Math.round(at)));
  return request<AggregatesResponse>(`/api/aggregates?${params.toString()}`);
}

export function fetchGlobalTrends(hours = 24): Promise<TrendsResponse> {
  return request<TrendsResponse>(`/api/trends/global?hours=${hours}`);
}

export function fetchCellTrends(cellId: string, hours = 24): Promise<TrendsResponse> {
  const params = new URLSearchParams({ cellId, hours: String(hours) });
  return request<TrendsResponse>(`/api/trends/cell?${params.toString()}`);
}

export function fetchInsights(): Promise<InsightsResponse> {
  return request<InsightsResponse>('/api/insights');
}

export function fetchMeta(): Promise<MetaResponse> {
  return request<MetaResponse>('/api/meta');
}

/**
 * Coarse server-side location estimate for this connection (snapped cell
 * center, never a raw lookup). 404 means the server couldn't estimate one.
 */
export async function fetchGeo(): Promise<GeoResponse | null> {
  try {
    return await request<GeoResponse>('/api/geo');
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

export function postReport(input: MoodReportInput): Promise<ReportAccepted> {
  return request<ReportAccepted>('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
