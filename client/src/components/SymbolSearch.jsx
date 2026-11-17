import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * "Company or symbol" input with NSE/BSE suggestions (arrow keys, Enter and Escape work in the list).
 * The parent owns the text (`query`) and the chosen suggestion (`picked`, null while typing).
 * `onType` runs on every keystroke, e.g. to clear a form message.
 */
export default function SymbolSearch({ id, query, setQuery, picked, setPicked, onType, label = 'Company or symbol' }) {
  const [results, setResults] = useState([]);
  const [active, setActive] = useState(-1); // highlighted suggestion, -1 = none
  const timer = useRef();
  const latest = useRef('');
  const listRef = useRef();

  const open = !picked && results.length > 0;
  const listId = `${id}-suggestions`;

  // A cleared box (e.g. after the form was submitted) closes the list.
  useEffect(() => {
    if (!query) setResults([]);
  }, [query]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onQuery = (v) => {
    setQuery(v);
    setPicked(null);
    setActive(-1);
    onType?.();
    clearTimeout(timer.current);
    latest.current = v.trim();
    if (latest.current.length < 2) return setResults([]);
    timer.current = setTimeout(() => {
      const q = latest.current;
      api
        .search(q)
        .then((r) => { if (q === latest.current) setResults(r); }) // ignore out-of-date responses
        .catch(() => setResults([]));
    }, 300);
  };

  const pick = (r) => {
    setPicked(r);
    setQuery(r.symbol);
    setResults([]);
    setActive(-1);
  };

  const onKeyDown = (e) => {
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = (active + step + results.length) % results.length;
      setActive(next);
      listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault(); // pick the suggestion instead of submitting the form
      pick(results[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setResults([]);
      setActive(-1);
    }
  };

  return (
    <>
      <label>
        {label}
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="e.g. Infosys or INFY.NS"
          required
          maxLength={40}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
        />
      </label>
      {open && (
        <ul className="suggest" id={listId} role="listbox" ref={listRef}>
          {results.map((r, i) => (
            <li
              key={r.symbol}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(r); }}
            >
              <strong>{r.symbol}</strong> <span className="muted">{r.name} · {r.exchange}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
