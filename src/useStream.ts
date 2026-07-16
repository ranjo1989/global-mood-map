import { useEffect, useRef, useState } from 'react';
import type { PulseEvent, UpdateEvent } from '@shared/types';

export interface StreamHandlers {
  onUpdate?: (e: UpdateEvent) => void;
  onPulse?: (e: PulseEvent) => void;
}

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Subscribes to /api/stream for the lifetime of the caller. EventSource
 * reconnects natively after errors; handlers live in a ref so callers may
 * pass fresh closures on every render without re-subscribing.
 */
export function useStream(handlers: StreamHandlers): { connected: boolean } {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('update', (ev) => {
      const data = parseJson<UpdateEvent>((ev as MessageEvent).data);
      if (data) handlersRef.current.onUpdate?.(data);
    });
    es.addEventListener('pulse', (ev) => {
      const data = parseJson<PulseEvent>((ev as MessageEvent).data);
      if (data) handlersRef.current.onPulse?.(data);
    });
    return () => es.close();
  }, []);

  return { connected };
}
