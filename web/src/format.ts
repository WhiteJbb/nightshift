import type { ProjectState } from '../../shared/types.ts';

export const STATE_LABEL: Record<ProjectState, string> = {
  running: '정상 실행',
  waiting: '입력 대기',
  idle: '유휴',
  stalled: '정지 의심',
  error: '오류',
  off: '꺼 둠',
};

/** now 는 스냅샷의 generatedAt (서버 시계 기준이라 렌더가 순수하게 유지된다) */
export function relTime(iso: string | null | undefined, now: string): string {
  if (!iso) return '—';
  const sec = Math.round((Date.parse(now) - Date.parse(iso)) / 1000);
  if (Number.isNaN(sec)) return '—';
  if (sec < 5) return '방금';
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  return `${Math.floor(hour / 24)}일 전`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 오늘이면 "14:23", 다른 날이면 "10/4 14:23". 초는 보여 주지 않는다 (경과 시간은 relTime 이 맡는다). */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

export function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}초`;
  return `${Math.floor(sec / 60)}분 ${Math.round(sec % 60)}초`;
}
