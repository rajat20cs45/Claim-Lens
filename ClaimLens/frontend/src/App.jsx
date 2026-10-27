import { useEffect, useRef, useState } from "react";
import "./App.css";
import Results from "./Results.jsx";
import { clearHistory, loadHistory, saveToHistory } from "./history.js";
import { clip, overallVerdict, timeAgo, verdictCounts } from "./factcheckUtils.js";
import {
  HeroArt,
  IconAlert,
  IconClipboard,
  IconImage,
  IconMonitor,
  IconMoon,
  IconSearch,
  IconSun,
  IconText,
  IconUpload,
  Logo,
} from "./Graphics.jsx";
import { useTheme } from "./theme.js";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";
const MAX_CHARS = 3000;
const MIN_CHARS = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const TIMEOUT_MS = 90000;

const EXAMPLES = [
  {
    label: "ATM ₹500 notes",
    tag: "Hinglish",
    text: "Bhai ye forward kar do, kal se sabhi ATM se 500 ke note band ho jayenge, RBI ne order nikala hai",
  },
  {
    label: "Free recharge",
    tag: "हिन्दी",
    text: "मोदी सरकार सभी को फ्री मोबाइल रिचार्ज दे रही है, इस लिंक पर क्लिक करके पाएं",
  },
  {
    label: "Cow urine and COVID",
    tag: "ਪੰਜਾਬੀ",
    text: "ਗਾਂ ਦਾ ਮੂਤਰ ਪੀਣ ਨਾਲ ਕੋਰੋਨਾ ਠੀਕ ਹੋ ਜਾਂਦਾ ਹੈ",
  },
  {
    label: "Lemon water and cancer",
    tag: "English",
    text: "Drinking hot water with lemon every morning cures cancer, doctors are hiding this!",
  },
  {
    label: "Chandrayaan-3 landing",
    tag: "English",
    text: "India's Chandrayaan-3 landed near the Moon's south pole in August 2023",
    fact: true,
  },
  {
    label: "WHO and COVID-19",
    tag: "हिन्दी",
    text: "WHO ने मार्च 2020 में कोविड-19 को वैश्विक महामारी घोषित किया था",
    fact: true,
  },
  {
    label: "Chandigarh capital",
    tag: "ਪੰਜਾਬੀ",
    text: "ਚੰਡੀਗੜ੍ਹ ਪੰਜਾਬ ਅਤੇ ਹਰਿਆਣਾ ਦੋਵਾਂ ਰਾਜਾਂ ਦੀ ਰਾਜਧਾਨੀ ਹੈ",
    fact: true,
  },
];

function messageFor(status, data) {
  const detail = typeof data?.detail === "string" ? data.detail : "";
  if (status === 503) return detail || "The AI checker is busy right now. Try again in a minute.";
  if (status === 413 || status === 415) return detail || "That image can't be used. Try a PNG or JPG under 5 MB.";
  if (status === 422) return `Use between ${MIN_CHARS} and ${MAX_CHARS.toLocaleString()} characters.`;
  return "Something went wrong. Try again.";
}

function ThemeToggle({ theme, setTheme }) {
  const options = [
    ["light", "Light theme", IconSun],
    ["system", "Match my system", IconMonitor],
    ["dark", "Dark theme", IconMoon],
  ];
  return (
    <div className="theme" role="group" aria-label="Colour theme">
      {options.map(([key, label, Icon]) => (
        <button
          type="button"
          key={key}
          className="theme-btn"
          aria-pressed={theme === key}
          aria-label={label}
          title={label}
          onClick={() => setTheme(key)}
        >
          <Icon width={16} height={16} />
        </button>
      ))}
    </div>
  );
}

// The server does not report progress, so the steps advance on a timer. They show the order of work, not live status.
function ScanSteps({ image }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSec((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const steps = [
    { at: 0, label: image ? "Reading the screenshot" : "Reading your message", note: "Finding the claim worth checking" },
    { at: 4, label: "Searching published fact-checks", note: "Looking across fact-checkers' sites" },
    { at: 10, label: "Comparing what we found", note: "Keeping only results about this claim" },
  ];
  let current = 0;
  steps.forEach((s, i) => {
    if (sec >= s.at) current = i;
  });
  return (
    <ol className="steps" aria-hidden="true">
      {steps.map((s, i) => (
        <li key={s.label} className={i < current ? "done" : i === current ? "now" : "next"}>
          <span className="step-mark">{i < current ? "✓" : i === current ? <span className="step-spin" /> : ""}</span>
          <span>
            <strong>{s.label}</strong>
            {i === current && <small>{s.note}</small>}
          </span>
        </li>
      ))}
      <li className="steps-time">{sec}s elapsed{sec >= 18 ? ". Slow answers usually mean the services are busy." : ""}</li>
    </ol>
  );
}

export default function App() {
  const [mode, setMode] = useState("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [resultKey, setResultKey] = useState(0);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [history, setHistory] = useState(() => loadHistory());
  const [quick, setQuick] = useState(() => (loadHistory().length ? "recent" : "examples"));
  const [notice, setNotice] = useState("");
  const [theme, setTheme] = useTheme();

  const abortRef = useRef(null);
  const outcomeRef = useRef(null);
  const textRef = useRef(null);

  // preview thumbnail for the attached screenshot
  useEffect(() => {
    if (!file) {
      setPreview("");
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // move focus to the answer so keyboard and screen-reader users land on it
  useEffect(() => {
    if (!(result || error) || !outcomeRef.current) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    outcomeRef.current.focus({ preventScroll: true });
    outcomeRef.current.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [result, error]);

  const canSubmit = !loading && (mode === "image" ? Boolean(file) : text.trim().length >= MIN_CHARS);

  function attach(f) {
    if (!f) return;
    if (!IMAGE_TYPES.includes(f.type)) {
      setError("Please choose a PNG, JPG or WebP image.");
      return;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      setError("That image is larger than 5 MB. Try a smaller screenshot.");
      return;
    }
    setError("");
    setResult(null);
    setFile(f);
    setMode("image");
  }

  function clearAll() {
    abortRef.current?.abort("cancel");
    setText("");
    setFile(null);
    setResult(null);
    setError("");
    setLoading(false);
    textRef.current?.focus();
  }

  function fillExample(example) {
    setMode("text");
    setFile(null);
    setResult(null);
    setError("");
    setText(example.text);
    setTimeout(() => textRef.current?.focus(), 0);
  }

  function openFromHistory(item) {
    abortRef.current?.abort("cancel");
    setLoading(false);
    setError("");
    setFile(null);
    setMode("text");
    setText("");
    setResult(item.result);
    setResultKey((k) => k + 1);
  }

  function wipeHistory() {
    setHistory(clearHistory());
  }

  async function pasteFromClipboard() {
    setNotice("");
    try {
      // a copied screenshot first, then plain text
      if (navigator.clipboard?.read) {
        try {
          for (const item of await navigator.clipboard.read()) {
            const type = item.types.find((t) => t.startsWith("image/"));
            if (type) {
              const blob = await item.getType(type);
              attach(new File([blob], `pasted-screenshot.${type.split("/")[1]}`, { type }));
              return;
            }
          }
        } catch {
          /* fall through to readText */
        }
      }
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) {
        setNotice("The clipboard is empty.");
        return;
      }
      setMode("text");
      setFile(null);
      setResult(null);
      setError("");
      setText(clip.slice(0, MAX_CHARS));
      if (clip.length > MAX_CHARS) setNotice(`Trimmed to the first ${MAX_CHARS.toLocaleString()} characters.`);
    } catch {
      setNotice("Your browser blocked clipboard access. Click in the box and press Ctrl+V instead.");
    }
  }

  function cancel() {
    abortRef.current?.abort("cancel");
    setLoading(false);
  }

  async function submit() {
    if (!canSubmit) return;
    abortRef.current?.abort("cancel");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const timer = setTimeout(() => ctrl.abort("timeout"), TIMEOUT_MS);
    setLoading(true);
    setError("");
    setResult(null);
    try {
      let res;
      if (mode === "image") {
        const form = new FormData();
        form.append("file", file);
        res = await fetch(`${API}/check-image`, { method: "POST", body: form, signal: ctrl.signal });
      } else {
        res = await fetch(`${API}/check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: text.trim() }),
          signal: ctrl.signal,
        });
      }
      const data = await res.json().catch(() => ({}));
      if (ctrl.signal.aborted) return;
      if (res.ok) {
        setResult(data);
        setResultKey((k) => k + 1);
        setHistory(saveToHistory(data, mode));
      } else {
        setError(messageFor(res.status, data));
      }
    } catch {
      if (ctrl.signal.reason === "timeout") {
        setError("The check took too long. Try again in a minute.");
      } else if (!ctrl.signal.aborted) {
        setError("Could not reach the server. Check that the backend is running.");
      }
    } finally {
      clearTimeout(timer);
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  }

  function onPaste(e) {
    const img = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
    if (img) {
      e.preventDefault();
      attach(img);
    }
  }

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    attach(e.dataTransfer?.files?.[0]);
  }

  function onTabKey(e) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setMode((m) => (m === "text" ? "image" : "text"));
    }
  }

  const showExamples = !result && !loading && !error;
  const compact = Boolean(result || loading || error);
  const hasHistory = history.length > 0;
  const quickTab = hasHistory ? quick : "examples";

  return (
    <>
      <header className={`hero${compact ? " hero-compact" : ""}`} id="top">
        <div className="container">
          <nav className="topbar" aria-label="Main">
            <a className="brand" href="#top">
              <Logo />
              <span>ClaimLens</span>
            </a>
            <div className="topbar-right">
              <ThemeToggle theme={theme} setTheme={setTheme} />
              <a className="toplink" href="#how">
                How it works
              </a>
            </div>
          </nav>

          <div className="hero-grid">
            <div className="hero-copy">
              <h1>
                Was that forward already <span className="nowrap">fact-checked?</span>
              </h1>
              <p className="lede">
                Paste a message or drop a screenshot. We find the fact-checks newsrooms have already published, in English,
                Hindi and Punjabi.
              </p>
            </div>
            <HeroArt className="hero-art" />
          </div>
        </div>
      </header>

      <main className="container main">
        <section
          className={`composer${dragging ? " composer-drag" : ""}${result ? " composer-compact" : ""}`}
          aria-label="Check a forward"
          onPaste={onPaste}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="composer-head">
            <div className="tabs" role="tablist" aria-label="What are you checking?" onKeyDown={onTabKey}>
              <button
                type="button"
                role="tab"
                id="tab-text"
                aria-selected={mode === "text"}
                aria-controls="panel-input"
                tabIndex={mode === "text" ? 0 : -1}
                className="tab"
                onClick={() => setMode("text")}
              >
                <IconText width={18} height={18} /> Paste text
              </button>
              <button
                type="button"
                role="tab"
                id="tab-image"
                aria-selected={mode === "image"}
                aria-controls="panel-input"
                tabIndex={mode === "image" ? 0 : -1}
                className="tab"
                onClick={() => setMode("image")}
              >
                <IconImage width={18} height={18} /> Screenshot
              </button>
            </div>
          </div>

          <div id="panel-input" role="tabpanel" aria-labelledby={mode === "text" ? "tab-text" : "tab-image"}>
            {mode === "text" ? (
              <>
                <label htmlFor="forward-text" className="sr-only">
                  Forwarded message
                </label>
                <textarea
                  id="forward-text"
                  ref={textRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit();
                  }}
                  placeholder="Paste the forwarded message here"
                  maxLength={MAX_CHARS}
                  disabled={loading}
                  rows={4}
                />
              </>
            ) : file ? (
              <div className="attached">
                {preview && <img src={preview} alt="The screenshot you attached" />}
                <div className="attached-text">
                  <p className="attached-name">{file.name}</p>
                  <p className="attached-note">
                    This screenshot is sent to Google's Gemini API to read the text. Crop out names and phone numbers first.
                  </p>
                  <button type="button" className="link-btn" onClick={() => setFile(null)} disabled={loading}>
                    Remove screenshot
                  </button>
                </div>
              </div>
            ) : (
              <label className="dropzone" htmlFor="file-input">
                <IconUpload width={30} height={30} />
                <span className="dropzone-title">Drop a screenshot here, paste it, or browse</span>
                <span className="dropzone-sub">PNG, JPG or WebP, up to 5 MB</span>
                <input
                  id="file-input"
                  className="sr-only"
                  type="file"
                  accept={IMAGE_TYPES.join(",")}
                  onChange={(e) => {
                    attach(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
            )}
          </div>

          <div className="composer-actions">
            <span className="composer-meta">
              {mode === "text" && text ? (
                `${text.length.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`
              ) : (
                <span className="hint">Ctrl + Enter to check</span>
              )}
            </span>
            {!file && (
              <button type="button" className="ghost" onClick={pasteFromClipboard} disabled={loading}>
                <IconClipboard width={18} height={18} /> Paste
              </button>
            )}
            {(text || file || result) && (
              <button type="button" className="ghost" onClick={clearAll}>
                Clear
              </button>
            )}
            <button type="button" className="primary" onClick={submit} disabled={!canSubmit}>
              {loading ? <span className="spinner" aria-hidden="true" /> : <IconSearch width={18} height={18} strokeWidth={2.4} />}
              {loading ? "Checking" : mode === "image" ? "Check screenshot" : "Check forward"}
            </button>
          </div>
          {notice && (
            <p className="composer-notice" role="status">
              {notice}
            </p>
          )}
        </section>

        <p className="scope-note">
          Best for viral rumours and forwards. Everyday facts and fresh news usually have no published fact-check, and this tool
          can't say whether a claim is true.
        </p>

        {showExamples && (
          <section className="quick" aria-label="Examples and recent checks">
            <div className="quick-head">
              <div className="tabs tabs-sm" role="group" aria-label="Show examples or recent checks">
                <button type="button" className="tab" aria-pressed={quickTab === "examples"} onClick={() => setQuick("examples")}>
                  Try an example
                </button>
                {hasHistory && (
                  <button type="button" className="tab" aria-pressed={quickTab === "recent"} onClick={() => setQuick("recent")}>
                    Recent <span className="tab-n">{history.length}</span>
                  </button>
                )}
              </div>
              {quickTab === "recent" && (
                <>
                  <span className="history-note">Saved only in this browser</span>
                  <button type="button" className="ghost ghost-sm" onClick={wipeHistory}>
                    Clear history
                  </button>
                </>
              )}
            </div>

            {quickTab === "examples" ? (
              <div className="examples">
                {EXAMPLES.map((ex) => (
                  <button type="button" className="example" key={ex.label} onClick={() => fillExample(ex)}>
                    {ex.label}
                    <span className="example-tag" lang={ex.tag === "हिन्दी" ? "hi" : ex.tag === "ਪੰਜਾਬੀ" ? "pa" : "en"}>
                      {ex.tag}
                    </span>
                  </button>
                ))}
                <p className="examples-hint">
                  The first four are known rumours. The last three are true facts. Fact-checkers rarely review true
                  facts, so expect "No fact-check yet", then use "Ask AI to check this".
                </p>
              </div>
            ) : (
              <ul className="history-list">
                {history.map((item) => {
                  const r = item.result;
                  const matches = r.matches || [];
                  const v = r.status === "match" ? overallVerdict(verdictCounts(matches)) : null;
                  const badge = r.status === "match" ? (v ? v.label : "Fact-checks found") : "Nothing found";
                  return (
                    <li key={item.id}>
                      <button type="button" className="history-item" onClick={() => openFromHistory(item)}>
                        <span className={`history-badge hb-${v ? v.key : r.status === "match" ? "found" : "none"}`}>{badge}</span>
                        <span className="history-claim">{clip(item.claim, 110)}</span>
                        <time dateTime={item.t}>{timeAgo(item.t)}</time>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {loading && (
          <section className="scan" role="status" aria-live="polite">
            <div className="scan-line" aria-hidden="true" />
            <div className="scan-head">
              <div>
                <p className="scan-title">Checking your forward</p>
                <p className="scan-sub">
                  Most checks take 5 to 15 seconds. You can cancel at any time.
                </p>
              </div>
              <button type="button" className="ghost" onClick={cancel}>
                Cancel
              </button>
            </div>
            <ScanSteps image={mode === "image"} />
          </section>
        )}

        {(result || error) && !loading && (
          <div className="outcome" ref={outcomeRef} tabIndex={-1} aria-label="Result">
            {error && (
              <div className="alert" role="alert">
                <IconAlert width={22} height={22} />
                <div>
                  <p>{error}</p>
                  {canSubmit && (
                    <button type="button" className="ghost" onClick={submit}>
                      Try again
                    </button>
                  )}
                </div>
              </div>
            )}
            {result && <Results key={resultKey} result={result} />}
          </div>
        )}

        <section className="how" id="how" aria-labelledby="how-title">
          <h2 id="how-title">How this works</h2>
          <ol className="how-steps">
            <li>
              <strong>We pull out the claim.</strong> An AI model reads your message or screenshot and writes the one thing
              that can be checked.
            </li>
            <li>
              <strong>We search published fact-checks.</strong> Short searches in English, Hindi and Punjabi go to fact-check
              databases and newsroom sites.
            </li>
            <li>
              <strong>We compare each one with your claim.</strong> The AI says whether it covers the same claim, a close
              variant, or just the same topic.
            </li>
          </ol>
          <p className="how-limits">
            Coverage is the limit: many claims, especially in Hindi and Punjabi, have no published fact-check, and no result
            doesn't mean a claim is true. The optional AI check is labelled and is not a fact-check. Test results are in the
            project README.
          </p>
        </section>
      </main>

      <footer className="footer">
        <div className="container">
          <p>Fact-checks come from independent newsrooms and fact-checking organisations. This tool only finds them.</p>
        </div>
      </footer>
    </>
  );
}
