'use strict';

function fmtDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return null;
}

hexo.extend.generator.register('qsl-data', function () {
  const raw = this.locals.get('data').qsl || [];

  const records = raw.map((r) => ({
    call: String(r.call || '').toUpperCase(),
    sent: r.sent === true,
    sent_date: fmtDate(r.sent_date),
    received: r.received === true,
    received_date: fmtDate(r.received_date),
    note: r.note ? String(r.note) : null,
  }));

  return {
    path: 'qsl/data.json',
    data: JSON.stringify(records),
  };
});
