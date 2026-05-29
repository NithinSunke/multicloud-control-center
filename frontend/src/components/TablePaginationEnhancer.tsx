import { useEffect } from 'react';

const PAGE_SIZES = [10, 25, 50];
const STATE_KEY = 'autoTablePaginationState';

type TableState = {
  page: number;
  pageSize: number;
};

declare global {
  interface HTMLTableElement {
    [STATE_KEY]?: TableState;
  }
}

function rowsFor(table: HTMLTableElement) {
  return Array.from(table.tBodies).flatMap((tbody) => Array.from(tbody.rows));
}

function stateFor(table: HTMLTableElement): TableState {
  if (!table[STATE_KEY]) {
    table[STATE_KEY] = { page: 1, pageSize: 10 };
  }
  return table[STATE_KEY];
}

function ensurePager(table: HTMLTableElement) {
  const parent = table.parentElement;
  if (!parent) {
    return null;
  }

  const existing = Array.from(parent.children).find(
    (child): child is HTMLDivElement =>
      child instanceof HTMLDivElement &&
      child.classList.contains('auto-table-pager') &&
      child.dataset.tablePager === table.dataset.tablePagerId,
  );
  if (existing) {
    return existing;
  }

  const pager = document.createElement('div');
  pager.className = 'auto-table-pager';
  pager.dataset.tablePager = table.dataset.tablePagerId || '';

  const pageInfo = document.createElement('span');
  pageInfo.className = 'auto-table-pager-info';
  pageInfo.dataset.role = 'page-info';

  const controls = document.createElement('div');
  controls.className = 'auto-table-pager-controls';

  const pageSize = document.createElement('select');
  pageSize.className = 'pm-input h-9';
  pageSize.setAttribute('aria-label', 'Rows per page');
  pageSize.dataset.role = 'page-size';
  for (const size of PAGE_SIZES) {
    const option = document.createElement('option');
    option.value = String(size);
    option.textContent = `${size} rows`;
    pageSize.appendChild(option);
  }

  const previous = document.createElement('button');
  previous.className = 'pm-button px-3 py-1.5 text-xs';
  previous.type = 'button';
  previous.textContent = 'Previous';
  previous.dataset.role = 'previous';

  const next = document.createElement('button');
  next.className = 'pm-button px-3 py-1.5 text-xs';
  next.type = 'button';
  next.textContent = 'Next';
  next.dataset.role = 'next';

  pageSize.addEventListener('change', () => {
    const state = stateFor(table);
    state.pageSize = Number(pageSize.value);
    state.page = 1;
    applyPagination(table);
  });

  previous.addEventListener('click', () => {
    const state = stateFor(table);
    state.page = Math.max(1, state.page - 1);
    applyPagination(table);
  });

  next.addEventListener('click', () => {
    const state = stateFor(table);
    state.page += 1;
    applyPagination(table);
  });

  controls.append(pageSize, previous, next);
  pager.append(pageInfo, controls);
  parent.appendChild(pager);

  return pager;
}

function applyPagination(table: HTMLTableElement) {
  const rows = rowsFor(table);
  const state = stateFor(table);
  const totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  const currentPage = Math.min(Math.max(1, state.page), totalPages);
  state.page = currentPage;

  const start = (currentPage - 1) * state.pageSize;
  const end = start + state.pageSize;
  rows.forEach((row, index) => {
    row.hidden = index < start || index >= end;
  });

  const pager = ensurePager(table);
  if (!pager) {
    return;
  }

  const pageInfo = pager.querySelector<HTMLElement>('[data-role="page-info"]');
  const pageSize = pager.querySelector<HTMLSelectElement>('[data-role="page-size"]');
  const previous = pager.querySelector<HTMLButtonElement>('[data-role="previous"]');
  const next = pager.querySelector<HTMLButtonElement>('[data-role="next"]');

  if (pageInfo) {
    pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
  }
  if (pageSize) {
    pageSize.value = String(state.pageSize);
  }
  if (previous) {
    previous.disabled = currentPage === 1;
  }
  if (next) {
    next.disabled = currentPage === totalPages;
  }
}

function enhanceTables(root: ParentNode) {
  const tables = Array.from(root.querySelectorAll<HTMLTableElement>('table')).filter((table) => {
    if (table.dataset.paginationManaged === 'react' || table.dataset.noAutoPagination === 'true') {
      return false;
    }
    if (table.closest('[data-no-auto-pagination="true"]')) {
      return false;
    }
    return true;
  });

  tables.forEach((table, index) => {
    if (!table.dataset.tablePagerId) {
      table.dataset.tablePagerId = `table-${Date.now()}-${index}`;
    }
    const rows = rowsFor(table);
    if (rows.length <= 10) {
      rows.forEach((row) => {
        row.hidden = false;
      });
      const parent = table.parentElement;
      const pager = parent
        ? Array.from(parent.children).find(
            (child): child is HTMLDivElement =>
              child instanceof HTMLDivElement &&
              child.classList.contains('auto-table-pager') &&
              child.dataset.tablePager === table.dataset.tablePagerId,
          )
        : undefined;
      pager?.remove();
      return;
    }
    applyPagination(table);
  });
}

export function TablePaginationEnhancer() {
  useEffect(() => {
    const root = document.querySelector('.app-shell');
    if (!root) {
      return undefined;
    }

    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => enhanceTables(root));
    };

    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return null;
}
