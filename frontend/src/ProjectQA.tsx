import { FormEvent, useEffect, useState } from 'react';
import { BookOpen, ChevronDown, CircleHelp, LoaderCircle, Send, ShieldCheck } from 'lucide-react';
import './ProjectQA.css';

type Citation = { path: string; start_line: number; end_line: number };
type Answer = { answer: string; citations: Citation[]; model: string; snapshot_id: string };
type Preview = { path: string; lines: { number: number; text: string }[] };
type QAHistoryEntry = {
  id: string;
  question: string;
  answer: string;
  citations: Citation[];
  model: string;
  created_at: string;
};

const API_URL = import.meta.env.VITE_API_URL ?? '';

const SUGGESTED_QUESTIONS = [
  'How is this project structured and what is its main entrypoint?',
  'Which files handle authentication or data persistence?',
  'What frameworks and external dependencies does this snapshot use?',
];

export function ProjectQA({
  projectId,
  snapshotId,
  csrfToken,
}: {
  projectId: string;
  snapshotId?: string;
  csrfToken: string;
}) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [model, setModel] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [history, setHistory] = useState<QAHistoryEntry[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_URL}/api/qa/status`, { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.detail ?? 'Could not read Q&A configuration.');
        setConfigured(Boolean(payload.configured));
        setModel(typeof payload.model === 'string' ? payload.model : '');
      })
      .catch((cause) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) setConfigured(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const qs = snapshotId ? `?snapshot_id=${encodeURIComponent(snapshotId)}` : '';
    fetch(`${API_URL}/api/projects/${encodeURIComponent(projectId)}/qa${qs}`, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : []))
      .then((rows) => {
        if (Array.isArray(rows)) setHistory(rows);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [projectId, snapshotId]);

  async function submitQuestion(text: string) {
    if (!snapshotId || !text.trim() || !configured || loading) return;
    setLoading(true);
    setError('');
    setPreview(null);
    try {
      const response = await fetch(`${API_URL}/api/projects/${encodeURIComponent(projectId)}/ask`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ snapshot_id: snapshotId, question: text.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.detail === 'string' ? payload.detail : 'Could not answer this question.');
      }
      const typed = payload as Answer;
      setAnswer(typed);
      setHistory((prev) => [
        {
          id: `${Date.now()}`,
          question: text.trim(),
          answer: typed.answer,
          citations: typed.citations,
          model: typed.model,
          created_at: new Date().toISOString(),
        },
        ...prev,
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not answer this question.');
    } finally {
      setLoading(false);
    }
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    await submitQuestion(question);
  }

  async function openCitation(citation: Citation) {
    if (!snapshotId) return;
    setError('');
    setPreview(null);
    const params = new URLSearchParams({
      path: citation.path,
      snapshot_id: snapshotId,
      start_line: String(citation.start_line),
      end_line: String(citation.end_line),
    });
    try {
      const response = await fetch(`${API_URL}/api/projects/${encodeURIComponent(projectId)}/source?${params}`, {
        credentials: 'same-origin',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.detail === 'string' ? payload.detail : 'Could not load the cited source lines.');
      }
      setPreview(payload as Preview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the cited source lines.');
    }
  }

  return (
    <section className="project-qa" aria-labelledby="project-qa-title">
      <div className="pqa-header">
        <div className="pqa-icon">
          <CircleHelp size={18} />
        </div>
        <div>
          <span className="pqa-kicker">SOURCE-GROUNDED Q&amp;A</span>
          <h2 id="project-qa-title">Ask about this snapshot</h2>
          <p>Answers are tied to the selected snapshot, saved to SQLite history, and backed by file citations.</p>
        </div>
        {configured && <span className="pqa-model">MODEL · {model}</span>}
      </div>

      {configured ? (
        <>
          <div className="pqa-suggestions">
            {SUGGESTED_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                className="pqa-suggestion-chip"
                disabled={loading || !snapshotId}
                onClick={() => {
                  setQuestion(q);
                  void submitQuestion(q);
                }}
              >
                {q}
              </button>
            ))}
          </div>
          <form className="pqa-form" onSubmit={ask}>
            <label className="sr-only" htmlFor="project-question">
              Ask a question about this project
            </label>
            <textarea
              id="project-question"
              value={question}
              maxLength={1000}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="How does the API authenticate requests? Which files would be affected by changing the data model?"
              rows={3}
            />
            <div className="pqa-form-foot">
              <span>{question.length}/1000 characters</span>
              <button type="submit" disabled={loading || !question.trim() || !snapshotId}>
                {loading ? (
                  <>
                    <LoaderCircle className="pqa-spin" size={14} /> Reading source
                  </>
                ) : (
                  <>
                    Ask question <Send size={13} />
                  </>
                )}
              </button>
            </div>
          </form>
          {answer && (
            <div className="pqa-answer" aria-live="polite">
              <div className="pqa-answer-label">
                <BookOpen size={13} /> ANSWER · {answer.model}
              </div>
              <p>{answer.answer}</p>
              {answer.citations.length > 0 && (
                <div className="pqa-citations">
                  <strong>Source evidence</strong>
                  {answer.citations.map((citation, index) => (
                    <button
                      key={`${citation.path}:${citation.start_line}:${index}`}
                      onClick={() => void openCitation(citation)}
                      type="button"
                    >
                      <code>{citation.path}</code>
                      <span>
                        L{citation.start_line}
                        {citation.end_line !== citation.start_line ? `–${citation.end_line}` : ''}
                      </span>
                      <ChevronDown size={12} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {preview && (
            <div className="pqa-source">
              <div>
                <strong>{preview.path}</strong>
                <span> cited lines</span>
                <button type="button" onClick={() => setPreview(null)} aria-label="Close source excerpt">
                  ×
                </button>
              </div>
              <pre>
                {preview.lines.map((line) => (
                  <span key={line.number}>
                    <i>{line.number}</i>
                    {line.text || ' '}
                    <br />
                  </span>
                ))}
              </pre>
            </div>
          )}
          {error && (
            <p className="pqa-error" role="alert">
              {error}
            </p>
          )}
          {history.length > 0 && (
            <div className="pqa-history">
              <div className="pqa-history-title">SAVED Q&amp;A HISTORY ({history.length})</div>
              {history.slice(0, 5).map((item) => (
                <div className="pqa-history-item" key={item.id}>
                  <div className="pqa-history-q">{item.question}</div>
                  <div className="pqa-history-a">{item.answer}</div>
                  {item.citations.length > 0 && (
                    <div className="pqa-citations" style={{ marginTop: 4 }}>
                      {item.citations.map((cit, i) => (
                        <button
                          key={`${item.id}-${cit.path}-${i}`}
                          type="button"
                          onClick={() => void openCitation(cit)}
                        >
                          <code>{cit.path}</code>
                          <span>
                            L{cit.start_line}
                            {cit.end_line !== cit.start_line ? `–${cit.end_line}` : ''}
                          </span>
                          <ChevronDown size={12} />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="pqa-disabled">
          <ShieldCheck size={15} />
          <p>Q&amp;A is currently unavailable because no Gemini API key is configured on the server environment.</p>
        </div>
      )}

      <div className="pqa-privacy">
        <ShieldCheck size={12} /> Source is treated as untrusted input; instructions inside project files are ignored. Only
        selected, bounded, redacted snippets are sent for Q&amp;A.
      </div>
    </section>
  );
}
