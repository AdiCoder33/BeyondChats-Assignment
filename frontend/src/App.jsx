import { useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000/api';

const formatDate = (value) => {
  if (!value) return 'Unpublished';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unpublished';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  }).format(date);
};

const ArticleCard = ({ label, article, tone = 'neutral', onOpen }) => {
  return (
    <article className={`article-card article-card--${tone}`}>
      <div className="article-card__header">
        <div>
          <p className="eyebrow">{label}</p>
          <h3>{article.title}</h3>
        </div>
        <span className="pill">{article.source || 'source'}</span>
      </div>
      <p className="meta">
        <span>{formatDate(article.published_at)}</span>
        <span>|</span>
        <span>{article.version || 'original'}</span>
      </p>
      <p className="excerpt">{article.excerpt || 'No excerpt available yet.'}</p>
      <button
        className="article-action"
        type="button"
        onClick={() => onOpen?.(article, label)}
      >
        Read full article
      </button>
    </article>
  );
};

function App() {
  const [articles, setArticles] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [modalArticle, setModalArticle] = useState(null);
  const [modalLabel, setModalLabel] = useState('');
  const [automationStatus, setAutomationStatus] = useState('idle');
  const [automationMessage, setAutomationMessage] = useState('');

  const loadArticles = useCallback(async (signal) => {
    try {
      setStatus('loading');
      const response = await fetch(
        `${API_BASE_URL}/articles?type=original&withUpdated=true`,
        signal ? { signal } : undefined
      );

      if (!response.ok) {
        throw new Error('Failed to load articles.');
      }

      const data = await response.json();
      setArticles(Array.isArray(data) ? data : []);
      setStatus('ready');
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError(err.message || 'Something went wrong.');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadArticles(controller.signal);
    return () => controller.abort();
  }, [loadArticles]);

  const fetchAutomationStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/automation/status`);
      if (!response.ok) {
        throw new Error('Failed to load automation status.');
      }

      const payload = await response.json();
      const nextStatus = payload.status || 'idle';
      setAutomationStatus(nextStatus);

      if (nextStatus === 'success') {
        const updated = payload.updated_count ?? 0;
        setAutomationMessage(
          payload.message || `Automation completed. Updated ${updated} articles.`
        );
        await loadArticles();
        return;
      }

      if (nextStatus === 'error') {
        setAutomationMessage(payload.message || 'Automation failed.');
        return;
      }

      if (nextStatus === 'running') {
        setAutomationMessage(payload.message || 'Automation running.');
        return;
      }

      setAutomationMessage('');
    } catch (err) {
      setAutomationStatus('error');
      setAutomationMessage(err.message || 'Failed to load automation status.');
    }
  }, [loadArticles]);

  useEffect(() => {
    fetchAutomationStatus();
  }, [fetchAutomationStatus]);

  useEffect(() => {
    if (automationStatus !== 'running') {
      return undefined;
    }

    const interval = setInterval(() => {
      fetchAutomationStatus();
    }, 5000);

    return () => clearInterval(interval);
  }, [automationStatus, fetchAutomationStatus]);

  const runAutomation = useCallback(async () => {
    try {
      setAutomationStatus('running');
      setAutomationMessage('Starting automation...');
      setError('');

      const response = await fetch(`${API_BASE_URL}/automation/run`, {
        method: 'POST',
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.message || 'Automation failed.');
      }

      setAutomationStatus('running');
      setAutomationMessage(payload.message || 'Automation started.');
      fetchAutomationStatus();
    } catch (err) {
      setAutomationStatus('error');
      setAutomationMessage(err.message || 'Automation failed.');
    }
  }, [fetchAutomationStatus]);

  useEffect(() => {
    if (!modalArticle) {
      return undefined;
    }

    const handleKey = (event) => {
      if (event.key === 'Escape') {
        setModalArticle(null);
      }
    };

    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = '';
    };
  }, [modalArticle]);

  const updatedCount = useMemo(
    () =>
      articles.reduce(
        (total, article) => total + (article.updated_articles || []).length,
        0
      ),
    [articles]
  );

  return (
    <div className="app">
      <header className="hero">
        <div className="hero__content">
          <p className="eyebrow">BeyondChats Labs</p>
          <h1>Article Evolution Studio</h1>
          <p className="hero__subtitle">
            Track original BeyondChats posts alongside LLM-enhanced versions inspired
            by top-ranking industry articles.
          </p>
          <div className="hero__actions">
            <button
              className="hero__button"
              type="button"
              onClick={runAutomation}
              disabled={automationStatus === 'running'}
            >
              {automationStatus === 'running'
                ? 'Running automation...'
                : 'Generate updated articles'}
            </button>
            <button
              className="hero__button hero__button--ghost"
              type="button"
              onClick={() => loadArticles()}
            >
              Refresh articles
            </button>
          </div>
          {automationStatus !== 'idle' && (
            <p
              className={`status ${
                automationStatus === 'error'
                  ? 'status--error'
                  : automationStatus === 'success'
                    ? 'status--success'
                    : 'status--info'
              }`}
            >
              {automationMessage}
            </p>
          )}
          <div className="hero__stats">
            <div className="stat-card">
              <span className="stat-label">Originals</span>
              <span className="stat-value">{articles.length}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Updated</span>
              <span className="stat-value">{updatedCount}</span>
            </div>
          </div>
        </div>
        <div className="hero__accent" aria-hidden="true" />
      </header>

      <main className="content">
        {status === 'loading' && <p className="status">Loading articles...</p>}
        {status === 'error' && <p className="status status--error">{error}</p>}

        {status === 'ready' && articles.length === 0 && (
          <p className="status">No articles found yet. Run the scraper first.</p>
        )}

        <div className="article-grid">
          {articles.map((article) => (
            <section className="article-group" key={article.id}>
              <div className="article-column">
                <ArticleCard
                  label="Original"
                  article={article}
                  tone="original"
                  onOpen={(item, label) => {
                    setModalArticle(item);
                    setModalLabel(label);
                  }}
                />
              </div>
              <div className="article-column">
                {(article.updated_articles || []).length > 0 ? (
                  article.updated_articles.map((updated) => (
                    <ArticleCard
                      key={updated.id}
                      label="Updated"
                      article={updated}
                      tone="updated"
                      onOpen={(item, label) => {
                        setModalArticle(item);
                        setModalLabel(label);
                      }}
                    />
                  ))
                ) : (
                  <div className="empty-card">
                    <p>No updated version yet.</p>
                    <p className="muted">
                      Run the automation script to generate a refreshed article.
                    </p>
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>
      </main>

      <footer className="footer">
        <p>BeyondChats Assignment | Built with Laravel, Node, and React</p>
      </footer>
      {modalArticle && (
        <div
          className="modal-backdrop"
          onClick={() => setModalArticle(null)}
          role="presentation"
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal__header">
              <div>
                <p className="eyebrow">{modalLabel}</p>
                <h2>{modalArticle.title}</h2>
                <p className="meta">
                  <span>{formatDate(modalArticle.published_at)}</span>
                  <span>|</span>
                  <span>{modalArticle.version || 'original'}</span>
                </p>
              </div>
              <button
                className="modal__close"
                type="button"
                onClick={() => setModalArticle(null)}
              >
                Close
              </button>
            </header>
            <div
              className="modal__body"
              dangerouslySetInnerHTML={{
                __html: modalArticle.content_html || '<p>No content available.</p>',
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
