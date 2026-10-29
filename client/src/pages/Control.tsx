import { ArrowDown, ArrowRight, ArrowUp, Megaphone, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Alert, Box, ConfirmDialog, Empty, errorText, formatWhen, letter, StatusPill, toast } from '../ui';

interface Contest { id: string; title: string; status: string; type: string; reserved: number; capacity: number; startsAt: string }
interface CatalogItem { problemId: string; title: string; tags: string[] }

const NEXT: Record<string, { to: string; label: string } | undefined> = {
  draft: { to: 'registration_open', label: 'open registration' },
  registration_open: { to: 'running', label: 'start' },
  running: { to: 'frozen', label: 'freeze board' },
  frozen: { to: 'ended', label: 'end' },
  ended: { to: 'published', label: 'publish results' },
};

function localInput(date: Date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
}

export function Control() {
  const [title, setTitle] = useState('Department round');
  const [type, setType] = useState<'coding' | 'quiz' | 'mixed'>('mixed');
  const [capacity, setCapacity] = useState(200);
  const [scoringMode, setScoringMode] = useState<'icpc' | 'ioi' | 'quiz'>('icpc');
  const [rejudgeReason, setRejudgeReason] = useState('');
  const [rejudgeSubmission, setRejudgeSubmission] = useState('');
  const [startNow, setStartNow] = useState(true);
  const [startsAt, setStartsAt] = useState(localInput(new Date(Date.now() + 30 * 60000)));
  const [minutes, setMinutes] = useState(120);
  const [freezeBefore, setFreezeBefore] = useState(30);
  const [picked, setPicked] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [contests, setContests] = useState<Contest[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [quizContest, setQuizContest] = useState('');
  const [rejudgeContest, setRejudgeContest] = useState('');
  const [integrityContest, setIntegrityContest] = useState('');
  const [pairs, setPairs] = useState<{ id: string; nameA: string; nameB: string; problem: string; score: number; sameIp: boolean; status: string; codeA?: string; codeB?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ title: string; body: string; confirm: string; danger?: boolean; run: () => Promise<void> } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const reload = useCallback(async () => {
    const rows = await api<Contest[]>('/api/contests');
    setContests(rows);
    const liveQuiz = rows.find((c) => c.type !== 'coding' && (c.status === 'running' || c.status === 'frozen'))?.id ?? '';
    setQuizContest((current) => current || liveQuiz);
    const fallback = rows.find((c) => c.status !== 'cancelled')?.id || '';
    setRejudgeContest((current) => current || fallback);
    setIntegrityContest((current) => current || fallback);
  }, []);

  useEffect(() => {
    reload().catch((e) => setError(errorText(e)));
    api<CatalogItem[]>('/api/catalog').then(setCatalog).catch((e) => setError(errorText(e)));
  }, [reload]);

  function toggle(problemId: string) {
    setPicked((current) => (current.includes(problemId) ? current.filter((id) => id !== problemId) : [...current, problemId]));
  }

  function shift(problemId: string, direction: -1 | 1) {
    setPicked((current) => {
      const index = current.indexOf(problemId);
      const next = index + direction;
      if (index < 0 || next < 0 || next >= current.length) return current;
      const copy = [...current];
      const swapped = copy[index]!;
      copy[index] = copy[next]!;
      copy[next] = swapped;
      return copy;
    });
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (type !== 'quiz' && picked.length === 0) { setError('Pick at least one problem for a coding or mixed contest.'); return; }
    if (freezeBefore >= minutes) { setError('The freeze has to start after the contest starts.'); return; }
    const start = startNow ? new Date() : new Date(startsAt);
    const end = new Date(start.getTime() + minutes * 60000);
    const freeze = new Date(end.getTime() - freezeBefore * 60000);
    setBusy(true);
    try {
      const result = await api<{ id: string }>('/api/contests', {
        method: 'POST',
        body: JSON.stringify({
          title, type, capacity,
          startsAt: start.toISOString(), endsAt: end.toISOString(), freezeAt: freeze.toISOString(),
          registrationOpensAt: new Date().toISOString(),
          scoringMode: type === 'quiz' ? 'quiz' : scoringMode,
          problemIds: type === 'quiz' ? [] : picked,
        }),
      });
      await api(`/api/contests/${result.id}/transition`, { method: 'POST', body: JSON.stringify({ to: 'registration_open' }) });
      if (startNow) await api(`/api/contests/${result.id}/transition`, { method: 'POST', body: JSON.stringify({ to: 'running' }) });
      toast(startNow ? `“${title}” is live` : 'Registration is open. The contest starts on schedule.', 'ok');
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function ask(next: { title: string; body: string; confirm: string; danger?: boolean; run: () => Promise<void> }) {
    setPending(next);
  }

  async function runPending() {
    if (!pending) return;
    setConfirming(true);
    setError('');
    try {
      await pending.run();
      setPending(null);
    } catch (err) {
      setError(errorText(err));
      setPending(null);
    } finally {
      setConfirming(false);
    }
  }

  async function rejudge(event: FormEvent) {
    event.preventDefault();
    if (!rejudgeContest) return;
    setError('');
    try {
      const result = await api<{ count: number }>(`/api/contests/${rejudgeContest}/rejudge`, {
        method: 'POST',
        body: JSON.stringify({ reason: rejudgeReason, ...(rejudgeSubmission ? { submissionId: rejudgeSubmission } : {}) }),
      });
      toast(`Queued ${result.count} submission${result.count === 1 ? '' : 's'} for rejudge`, 'ok');
      setRejudgeReason('');
      setRejudgeSubmission('');
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function openQuestion() {
    setError('');
    try {
      if (!quizContest) return;
      const opened = await api<{ prompt: string }>(`/api/contests/${quizContest}/quiz/next`, { method: 'POST' });
      toast(`Open now: ${opened.prompt}`, 'ok');
    } catch (err) {
      setError(errorText(err));
    }
  }

  const quizContests = contests.filter((c) => c.type !== 'coding' && (c.status === 'running' || c.status === 'frozen'));
  const shownCatalog = catalog.filter((item) => `${item.title} ${item.tags.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const liveCount = contests.filter((c) => c.status === 'running' || c.status === 'frozen').length;

  return (
    <div className="page">
      <div className="page-head"><div><h1>Control</h1><p>Run the contest lifecycle and push quiz questions.</p></div></div>
      {error ? <Alert>{error}</Alert> : null}

      <div className="stats">
        <div className="box stat"><b>{contests.length}</b><span>contests</span></div>
        <div className="box stat"><b className="ok">{liveCount}</b><span>live now</span></div>
        <div className="box stat"><b>{contests.reduce((sum, c) => sum + c.reserved, 0)}</b><span>seats taken</span></div>
        <div className="box stat"><b>{catalog.length}</b><span>published problems</span></div>
      </div>

      <div className="with-side">
        <div className="stack">
          <Box title="contests" flush>
            {contests.length === 0 ? <Empty title="No contests yet">Create one below.</Empty> : (
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead><tr><th>title</th><th>start</th><th>seats</th><th>status</th><th className="r">next step</th></tr></thead>
                  <tbody>
                    {contests.map((c) => {
                      const next = NEXT[c.status];
                      return (
                        <tr key={c.id}>
                          <td><Link className="row-link" to={`/arena/${c.id}`}>{c.title}</Link><div className="muted small">{c.type}</div></td>
                          <td className="nowrap small">{formatWhen(c.startsAt)}</td>
                          <td className="num">{c.reserved}/{c.capacity}</td>
                          <td><StatusPill status={c.status} /></td>
                          <td className="r">
                            <span className="row" style={{ justifyContent: 'flex-end' }}>
                              {next ? <button className="btn sm" type="button" onClick={() => ask({
                                title: `${next.label} “${c.title}”?`,
                                body: 'This cannot be undone.',
                                confirm: next.label,
                                run: async () => {
                                  await api(`/api/contests/${c.id}/transition`, { method: 'POST', body: JSON.stringify({ to: next.to }) });
                                  toast(`${c.title}: ${next.label}`, 'ok');
                                  await reload();
                                },
                              })}>{next.label} <ArrowRight size={13} /></button> : <span className="muted small">{c.status === 'cancelled' ? 'cancelled' : 'done'}</span>}
                              {c.status !== 'published' && c.status !== 'cancelled' ? <button className="btn danger sm" type="button" onClick={() => ask({
                                title: `Cancel “${c.title}”?`,
                                body: 'Every seat is released. The contest cannot restart.',
                                confirm: 'cancel contest',
                                danger: true,
                                run: async () => {
                                  await api(`/api/contests/${c.id}/transition`, { method: 'POST', body: JSON.stringify({ to: 'cancelled' }) });
                                  toast(`${c.title}: cancel`, 'ok');
                                  await reload();
                                },
                              })}>cancel</button> : null}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Box>

          <Box title="new contest">
            <form onSubmit={create}>
              <div className="field-row">
                <div><label htmlFor="title" style={{ marginTop: 0 }}>Title</label><input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required /></div>
                {type !== 'quiz' ? (
                  <div>
                    <label htmlFor="scoring" style={{ marginTop: 0 }}>Scoring</label>
                    <select id="scoring" value={scoringMode} onChange={(e) => setScoringMode(e.target.value as 'icpc' | 'ioi')}>
                      <option value="icpc">ICPC penalty</option>
                      <option value="ioi">IOI partial scores</option>
                    </select>
                  </div>
                ) : null}
                <div>
                  <label htmlFor="type" style={{ marginTop: 0 }}>Type</label>
                  <select id="type" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                    <option value="mixed">Coding and quiz</option>
                    <option value="coding">Coding</option>
                    <option value="quiz">Quiz</option>
                  </select>
                </div>
              </div>
              <div className="field-row">
                <div><label htmlFor="cap">Seats</label><input id="cap" type="number" min={1} value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} /></div>
                <div><label htmlFor="minutes">Length (minutes)</label><input id="minutes" type="number" min={5} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></div>
                <div><label htmlFor="freeze">Freeze before end (minutes)</label><input id="freeze" type="number" min={0} value={freezeBefore} onChange={(e) => setFreezeBefore(Number(e.target.value))} /></div>
              </div>
              <div className="field-row">
                <div>
                  <label htmlFor="start">Start</label>
                  <input id="start" type="datetime-local" value={startsAt} disabled={startNow} onChange={(e) => setStartsAt(e.target.value)} />
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: '0.5rem' }}>
                  <label className="check"><input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} /> start right away</label>
                </div>
              </div>
              {type !== 'quiz' ? (
                <>
                  <div className="row between">
                    <label>Problems · {picked.length} picked. Order below is A, B, C…</label>
                    <div className="input-icon" style={{ width: '14rem', marginTop: 'var(--space-2)' }}><Search size={14} /><input aria-label="Search problems" placeholder="search" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
                  </div>
                  {picked.length > 0 ? (
                    <ol className="order-list">
                      {picked.map((id, index) => {
                        const item = catalog.find((row) => row.problemId === id);
                        return (
                          <li key={id}>
                            <span className="letter">{letter(index)}</span>
                            <span className="grow">{item?.title ?? id}</span>
                            <button className="btn ghost icon sm" type="button" aria-label={`Move ${item?.title ?? 'problem'} up`} disabled={index === 0} onClick={() => shift(id, -1)}><ArrowUp size={13} /></button>
                            <button className="btn ghost icon sm" type="button" aria-label={`Move ${item?.title ?? 'problem'} down`} disabled={index === picked.length - 1} onClick={() => shift(id, 1)}><ArrowDown size={13} /></button>
                          </li>
                        );
                      })}
                    </ol>
                  ) : <p className="muted small">Nothing picked yet.</p>}
                  <div className="pick-list" style={{ marginTop: 'var(--space-2)' }}>
                    {shownCatalog.map((item) => (
                      <label key={item.problemId} className={picked.includes(item.problemId) ? 'on' : ''}>
                        <input type="checkbox" checked={picked.includes(item.problemId)} onChange={() => toggle(item.problemId)} />
                        <span className="grow">{item.title}</span>
                        {item.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}
                      </label>
                    ))}
                    {shownCatalog.length === 0 ? <Empty title="No published problems match" /> : null}
                  </div>
                </>
              ) : null}
              <button className="btn primary" type="submit" disabled={busy} style={{ marginTop: 'var(--space-4)' }}><Plus size={14} /> {busy ? 'creating…' : startNow ? 'create and start' : 'create and open registration'}</button>
            </form>
          </Box>
        </div>

        <aside className="side">
          <Box title="quiz">
            {quizContests.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No live quiz or mixed contest.</p> : (
              <div className="stack tight">
                <select aria-label="Contest" value={quizContest} onChange={(e) => setQuizContest(e.target.value)}>
                  {quizContests.map((contest) => <option key={contest.id} value={contest.id}>{contest.title}</option>)}
                </select>
                <button className="btn primary" type="button" disabled={!quizContests.some((c) => c.id === quizContest)} onClick={openQuestion}>
                  <Megaphone size={14} /> open next question
                </button>
                <p className="muted small" style={{ margin: 0 }}>Everyone in the room sees it at once. A new question can open once the current one closes.</p>
              </div>
            )}
          </Box>
          <Box title="rejudge">
            <form onSubmit={rejudge} className="stack tight">
              <select aria-label="Contest to rejudge" value={rejudgeContest} onChange={(e) => setRejudgeContest(e.target.value)}>
                {contests.filter((c) => c.status !== 'cancelled').map((contest) => <option key={contest.id} value={contest.id}>{contest.title}</option>)}
              </select>
              <label htmlFor="reason" style={{ marginTop: 0 }}>Reason</label>
              <input id="reason" value={rejudgeReason} onChange={(e) => setRejudgeReason(e.target.value)} required minLength={3} placeholder="why the verdicts should be thrown out" />
              <label htmlFor="one">One submission id, or leave empty for the whole contest</label>
              <input id="one" value={rejudgeSubmission} onChange={(e) => setRejudgeSubmission(e.target.value)} placeholder="optional" />
              <button className="btn sm" type="submit" disabled={!rejudgeContest}>rejudge</button>
              <p className="muted small" style={{ margin: 0 }}>Finished submissions go back on the queue. The audit row stores the old verdicts and this reason.</p>
            </form>
          </Box>
          <Box title="integrity">
            <div className="stack tight">
              <select aria-label="Contest to check" value={integrityContest} onChange={(e) => { setIntegrityContest(e.target.value); setPairs([]); }}>
                {contests.filter((c) => c.status !== 'cancelled').map((contest) => <option key={contest.id} value={contest.id}>{contest.title}</option>)}
              </select>
              <button className="btn sm" type="button" disabled={!integrityContest} onClick={() => {
                setError('');
                api<{ pairs: typeof pairs }>(`/api/contests/${integrityContest}/integrity/run`, { method: 'POST', body: '{}' })
                  .then(() => api<{ pairs: typeof pairs }>(`/api/contests/${integrityContest}/integrity`))
                  .then((report) => { setPairs(report.pairs); toast(`${report.pairs.length} similar pair(s)`, report.pairs.length ? 'warn' : 'ok'); })
                  .catch((err) => setError(errorText(err)));
              }}>run check</button>
              <p className="muted small" style={{ margin: 0 }}>Compares the last accepted submission on each problem. A match is a review, never an automatic disqualification. Checks also run when a contest ends.</p>
              {pairs.map((pair) => (
                <div key={pair.id} className="stack tight" style={{ borderTop: '1px solid var(--line)', paddingTop: '0.4rem' }}>
                  <span className="small">{pair.nameA} · {pair.nameB}</span>
                  <span className="muted small">{pair.problem} · {Math.round(pair.score * 100)}%{pair.sameIp ? ' · same network' : ''} · {pair.status}</span>
                  <div className="row">
                    <button className="btn ghost sm" type="button" onClick={() => {
                      api<typeof pair>(`/api/contests/${integrityContest}/integrity/pairs/${encodeURIComponent(pair.id)}`)
                        .then((full) => setPairs((current) => current.map((row) => row.id === pair.id ? { ...row, ...full } : row)))
                        .catch((err) => setError(errorText(err)));
                    }}>view</button>
                    <button className="btn sm" type="button" onClick={() => {
                      api(`/api/contests/${integrityContest}/integrity/pairs/${encodeURIComponent(pair.id)}`, { method: 'POST', body: JSON.stringify({ decision: 'dismissed', note: '' }) })
                        .then(() => setPairs((current) => current.map((row) => row.id === pair.id ? { ...row, status: 'dismissed' } : row)))
                        .catch((err) => setError(errorText(err)));
                    }}>dismiss</button>
                    <button className="btn danger sm" type="button" onClick={() => {
                      api(`/api/contests/${integrityContest}/integrity/pairs/${encodeURIComponent(pair.id)}`, { method: 'POST', body: JSON.stringify({ decision: 'confirmed', note: '' }) })
                        .then(() => setPairs((current) => current.map((row) => row.id === pair.id ? { ...row, status: 'confirmed' } : row)))
                        .catch((err) => setError(errorText(err)));
                    }}>confirm</button>
                  </div>
                  {pair.codeA != null ? (
                    <div className="two">
                      {[pair.codeA, pair.codeB ?? ''].map((code, index) => (
                        <pre key={index} className="small" style={{ margin: 0, overflow: 'auto', maxHeight: '12rem' }}>{code}</pre>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </Box>
          <Box title="lifecycle">
            <ol className="muted small" style={{ margin: 0, paddingLeft: '1.1rem', lineHeight: 1.9 }}>
              <li>draft → open registration</li>
              <li>start: seats become competing</li>
              <li>freeze: the public board stops moving</li>
              <li>end: submissions close</li>
              <li>publish: final board, ratings, editorials, practice</li>
              <li>cancel: seats are released, from any step before publish</li>
            </ol>
          </Box>
        </aside>
      </div>
      {pending ? (
        <ConfirmDialog
          title={pending.title}
          body={pending.body}
          confirm={pending.confirm}
          danger={pending.danger}
          busy={confirming}
          onCancel={() => { if (!confirming) setPending(null); }}
          onConfirm={() => { void runPending(); }}
        />
      ) : null}
    </div>
  );
}
