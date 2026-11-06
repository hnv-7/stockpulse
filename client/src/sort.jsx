import { useMemo, useState } from 'react';

/** Sort rows by a key; text sorts A–Z, numbers sort numerically, missing values always go last. */
export function useSort(rows, initial) {
  const [sort, setSort] = useState(initial);

  const sorted = useMemo(() => {
    const { key, dir } = sort;
    const factor = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = a[key];
      const y = b[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const cmp = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return cmp * factor;
    });
  }, [rows, sort]);

  // First click: text A–Z, numbers highest first. Clicking again reverses.
  const toggle = (key, textual) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: textual ? 'asc' : 'desc' },
    );

  return { sorted, sort, toggle };
}

export function SortTh({ label, k, sort, toggle, textual = false, right = true }) {
  const active = sort.key === k;
  const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return (
    <th className={right ? 'r' : ''} aria-sort={ariaSort}>
      <button type="button" className={active ? 'sort-btn on' : 'sort-btn'} onClick={() => toggle(k, textual)}>
        {label}
        <span aria-hidden="true" className="arrow">{active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );
}
