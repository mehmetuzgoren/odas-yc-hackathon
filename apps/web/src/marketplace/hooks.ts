import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { defaultSelection, intervalParams } from './time';

export function useRemote<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    if (!path) { setData(null); setLoading(false); return; }
    api<T>(path).then(value => { if (active) setData(value); }).catch(error => { if (active) { setData(null); setError(error.message || 'Something went wrong. Please try again.'); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, retry]);
  return { data, loading, error, retry: () => setRetry(value => value + 1) };
}

export function useInterval() {
  const [params] = useSearchParams();
  let query = new URLSearchParams(params); let error = '';
  try { query = intervalParams(params); } catch (cause) { error = cause instanceof Error ? cause.message : 'Choose valid date and times.'; }
  const fallback = defaultSelection();
  return { query, error, selection: { date: query.get('date') || fallback.date, start: query.get('start') || fallback.start, end: query.get('end') || fallback.end } };
}

export const intervalOnly = (query: URLSearchParams) => new URLSearchParams(['date', 'start', 'end', 'startAt', 'endAt'].flatMap(key => query.has(key) ? [[key, query.get(key)!]] : [])).toString();
