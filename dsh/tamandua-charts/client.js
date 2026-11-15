// Draws charts inside the Tamandua MCP tool cards.
// Plain browser module: React comes from the Harness module table, so there is
// no bundler step and no client package import.
window.__ModuleLoader__.load({
  id: '@local/tamandua-charts',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'tamanduaCharts';
    const DICT = {
      portfolio: 'Portfolio value',
      notConverted: 'not converted, per currency',
      assets: 'assets',
      asset: 'asset',
      accounts: 'accounts',
      account: 'account',
      emptyPortfolio: 'No holdings with a value recorded',
      cashflow: 'Cash flow',
      income: 'Income',
      spending: 'Spending',
      net: 'Net',
      category: 'Spending by category',
      noSpending: 'No spending recorded for this month',
      dividends: 'Dividends received',
      fromQuery: 'from this query',
      payments: 'payments',
      payment: 'payment',
      noDividends: 'No dividends recorded',
      failed: 'Chart unavailable',
      unavailable: 'No chart data in this result',
      running: 'Reading Tamandua…',
    };

    // --- Payload discovery --------------------------------------------------
    // Tool results reach the view as MCP text blocks. The exact envelope belongs
    // to the Chat contract, so the payload is matched by shape, not by nesting.

    function parseJson(text) {
      const candidate = text.trim();
      if (candidate.charAt(0) !== '{' && candidate.charAt(0) !== '[') return undefined;
      try {
        return JSON.parse(candidate);
      } catch {
        return undefined;
      }
    }

    function findPayload(root, test) {
      const seen = new Set();
      const visit = (value, depth) => {
        if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return undefined;
        seen.add(value);
        if (test(value)) return value;
        const children = Array.isArray(value) ? value : Object.keys(value).map((key) => value[key]);
        for (const child of children) {
          if (typeof child === 'string') {
            const parsed = parseJson(child);
            if (parsed !== undefined) {
              const hit = visit(parsed, depth + 1);
              if (hit !== undefined) return hit;
            }
          } else if (child && typeof child === 'object') {
            const hit = visit(child, depth + 1);
            if (hit !== undefined) return hit;
          }
        }
        return undefined;
      };
      return visit(root, 0);
    }

    // A successful query can still return an empty list; that is data, not a failure.
    function hasEmptyJsonArray(root) {
      const seen = new Set();
      const visit = (value, depth) => {
        if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return false;
        seen.add(value);
        const children = Array.isArray(value) ? value : Object.keys(value).map((key) => value[key]);
        for (const child of children) {
          if (typeof child === 'string') {
            const parsed = parseJson(child);
            if (Array.isArray(parsed) && parsed.length === 0) return true;
            if (parsed !== undefined && visit(parsed, depth + 1)) return true;
          } else if (child && typeof child === 'object' && visit(child, depth + 1)) {
            return true;
          }
        }
        return false;
      };
      return visit(root, 0);
    }

    // Failed calls carry a plain explanation; surface it instead of a generic line.
    function findMessage(root, toolName) {
      const seen = new Set();
      const visit = (value, depth) => {
        if (value == null || depth > 8) return undefined;
        if (typeof value === 'string') {
          const text = value.trim();
          if (text.length < 8 || text.length > 400 || text === toolName) return undefined;
          if (text.charAt(0) === '{' || text.charAt(0) === '[' || !text.includes(' ')) return undefined;
          return text;
        }
        if (typeof value !== 'object' || seen.has(value)) return undefined;
        seen.add(value);
        const children = Array.isArray(value) ? value : Object.keys(value).map((key) => value[key]);
        for (const child of children) {
          const hit = visit(child, depth + 1);
          if (hit !== undefined) return hit;
        }
        return undefined;
      };
      return visit(root, 0);
    }

    const TESTS = {
      summary: (value) => !Array.isArray(value) && !!value.valueByCurrency && Array.isArray(value.holdings),
      cashflow: (value) => !Array.isArray(value) && !!value.totals_by_currency,
      dividends: (value) => Array.isArray(value) && value.length > 0
        && value.every((row) => row && typeof row === 'object' && typeof row.date === 'string' && row.amount != null),
    };

    // --- Formatting and primitives -----------------------------------------

    function formatInt(value) {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
    }

    function formatDec(value) {
      return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
    }

    // No filled card: in the light theme bg-layer-1/2 are both the page colour,
    // so the frame comes from a border and the tracks from the border token.
    const STYLE = {
      card: {
        display: 'flex', flexDirection: 'column', gap: 8,
        width: '100%', maxWidth: 560, boxSizing: 'border-box',
        padding: '10px 12px', borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
      },
      head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
      title: { fontWeight: 600 },
      note: { fontSize: '0.92em', color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'grid', gridTemplateColumns: '44px 1fr 96px', alignItems: 'center', gap: 8, fontSize: '0.92em' },
      track: { height: 8, borderRadius: 4, background: 'var(--dsw-alias-border-l2)', overflow: 'hidden' },
      fill: { height: '100%', borderRadius: 4, background: 'var(--dsw-alias-brand-primary)' },
      label: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      value: { textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
      foot: { fontSize: '0.92em', color: 'var(--dsw-alias-label-secondary)' },
      totals: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.92em' },
      totalLine: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline' },
      strong: { fontWeight: 600 },
      stat: { fontSize: '1.6em', fontWeight: 600, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' },
    };

    function card(title, note, children, foot) {
      return h('div', { style: STYLE.card, role: 'group', 'aria-label': title },
        h('div', { style: STYLE.head },
          h('div', { style: STYLE.title }, title),
          note ? h('div', { style: STYLE.note }, note) : null),
        ...children,
        foot ? h('div', { style: STYLE.foot }, foot) : null);
    }

    function bars(items, max) {
      return items.map((item) =>
        h('div', { key: item.key, style: STYLE.row },
          h('span', { style: STYLE.label, title: item.label }, item.label),
          h('div', { style: STYLE.track },
            h('div', {
              style: { ...STYLE.fill, width: Math.max(2, Math.round((item.value / max) * 100)) + '%' },
            })),
          h('span', { style: STYLE.value, title: item.display }, item.display)));
    }

    // --- Views ---------------------------------------------------------------

    function summaryCard(data, t) {
      const rows = Object.entries(data.valueByCurrency || {})
        .map(([currency, value]) => ({
          key: currency,
          label: currency,
          value: Number(value) || 0,
          display: formatInt(Number(value) || 0) + ' ' + currency,
        }))
        .filter((row) => row.value > 0)
        .sort((a, b) => b.value - a.value);
      const max = rows.length ? rows[0].value : 1;
      const holdings = Array.isArray(data.holdings) ? data.holdings.length : 0;
      const accounts = Number(data.accountCount) || 0;
      const foot = [
        holdings ? holdings + ' ' + t(holdings === 1 ? 'asset' : 'assets') : null,
        accounts ? accounts + ' ' + t(accounts === 1 ? 'account' : 'accounts') : null,
      ].filter(Boolean).join(' · ');
      if (!rows.length) return card(t('portfolio'), t('notConverted'), [h('div', { style: STYLE.note }, t('emptyPortfolio'))], foot || undefined);
      return card(t('portfolio'), t('notConverted'), bars(rows, max), foot || undefined);
    }

    function cashflowCard(data, t) {
      const totals = Object.entries(data.totals_by_currency || {});
      const raw = Array.isArray(data.spending_by_category) ? data.spending_by_category : [];
      const byCurrency = new Map();
      for (const entry of raw) {
        const currency = entry && entry.currency ? String(entry.currency) : '';
        const list = byCurrency.get(currency) || [];
        list.push({
          key: String(entry && entry.category_id != null ? entry.category_id : list.length) + '-' + currency,
          label: entry && entry.name ? String(entry.name) : '—',
          value: Number(entry && entry.total) || 0,
          display: formatDec(Number(entry && entry.total) || 0),
        });
        byCurrency.set(currency, list);
      }
      const sections = Array.from(byCurrency, ([currency, items]) => {
        const sorted = items.filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
        return { currency, items: sorted, max: sorted.length ? sorted[0].value : 1 };
      }).filter((section) => section.items.length);

      const children = [];
      if (totals.length) {
        children.push(h('div', { style: STYLE.totals }, totals.map(([currency, value]) => {
          const amounts = value || {};
          return h('div', { key: currency, style: STYLE.totalLine },
            h('strong', { style: STYLE.strong }, currency),
            h('span', { style: STYLE.note }, t('income') + ' ' + formatDec(Number(amounts.income) || 0)),
            h('span', { style: STYLE.note }, t('spending') + ' ' + formatDec(Number(amounts.expense) || 0)),
            h('span', { style: STYLE.note }, t('net') + ' ' + formatDec(Number(amounts.net) || 0)));
        })));
      }

      if (sections.length) {
        children.push(h('div', { style: STYLE.note }, t('category')));
        for (const section of sections) {
          if (sections.length > 1) children.push(h('div', { style: STYLE.note }, section.currency));
          children.push(...bars(section.items, section.max));
        }
      } else {
        children.push(h('div', { style: STYLE.note }, t('noSpending')));
      }

      return card(t('cashflow'), data.month ? String(data.month) : null, children, undefined);
    }

    function dividendsCard(data, t) {
      const rows = Array.isArray(data) ? data : [];
      const buckets = new Map();
      for (const row of rows) {
        const year = String(row && row.date ? row.date : '').slice(0, 4);
        if (!year) continue;
        const currency = row.currency ? String(row.currency) : '';
        const key = year + '|' + currency;
        const item = buckets.get(key) || { key, label: year, currency, value: 0 };
        item.value += Number(row.amount) || 0;
        buckets.set(key, item);
      }
      const items = Array.from(buckets.values())
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((item) => ({
          ...item,
          display: formatDec(item.value) + (item.currency ? ' ' + item.currency : ''),
        }));
      const currencies = Array.from(new Set(rows.map((row) => row.currency).filter(Boolean)));
      const foot = rows.length
        ? rows.length + ' ' + t(rows.length === 1 ? 'payment' : 'payments') + (currencies.length === 1 ? ' · ' + currencies[0] : '')
        : undefined;

      if (!items.length) return card(t('dividends'), t('fromQuery'), [h('div', { style: STYLE.note }, t('noDividends'))], foot);
      if (items.length === 1) {
        return card(t('dividends'), t('fromQuery'), [h('div', { style: STYLE.stat }, items[0].display)], foot);
      }
      const max = Math.max(...items.map((item) => item.value));
      return card(t('dividends'), t('fromQuery'), bars(items, max), foot);
    }

    function makeView(kind, t) {
      return function TamanduaChartView(props) {
        if (!props || props.phase !== 'result') {
          return card(t('running'), t(kind === 'summary' ? 'portfolio' : kind === 'cashflow' ? 'cashflow' : 'dividends'), [], undefined);
        }
        const data = findPayload(props.block, TESTS[kind]);
        if (data === undefined) {
          if (kind === 'dividends' && hasEmptyJsonArray(props.block)) {
            return card(t('dividends'), t('fromQuery'), [h('div', { style: STYLE.note }, t('noDividends'))], undefined);
          }
          const message = findMessage(props.block, props.toolName);
          return card(t('failed'), null, [h('div', { style: STYLE.note }, message || t('unavailable'))], undefined);
        }
        if (kind === 'summary') return summaryCard(data, t);
        if (kind === 'cashflow') return cashflowCard(data, t);
        return dividendsCard(data, t);
      };
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let translate = (key) => DICT[key] || key;
        try {
          const locale = ctx.get('locale');
          if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
            let registered = false;
            try {
              ctx.effect(() => locale.register(NS, 'en', DICT));
              registered = true;
            } catch {
              registered = false;
            }
            if (registered) translate = locale.bind(NS);
          }
        } catch {
          // The locale service is optional for this view; literal English stays usable.
        }

        const views = {
          'mcp__tamandua__get_summary': makeView('summary', translate),
          'mcp__tamandua__get_cash_flow_summary': makeView('cashflow', translate),
          'mcp__tamandua__list_dividends': makeView('dividends', translate),
        };

        ctx.slots.inject('tool.call.toolview', () => {
          const disposers = Object.keys(views).map((key) =>
            ctx.slots.register({ name: 'tool.call.toolview', key }, views[key]));
          return () => disposers.forEach((dispose) => {
            try {
              dispose();
            } catch {
              // Already disposed with its owning context.
            }
          });
        });
      },
    };
  },
});
