---
title: QSL 卡片登记
date: 2026-07-24 12:00:00
aside: false
comments: true
---

<div id="qsl-app">
  <div class="qsl-stats" id="qsl-stats"></div>
  <div class="qsl-filters" id="qsl-filters"></div>
  <div class="qsl-table-wrap">
    <table class="qsl-table">
      <thead>
        <tr>
          <th>状态</th>
          <th>呼号</th>
          <th>发出</th>
          <th>收到</th>
          <th>备注</th>
        </tr>
      </thead>
      <tbody id="qsl-tbody"></tbody>
    </table>
  </div>
  <p class="qsl-empty" id="qsl-empty" hidden>当前筛选下没有记录。</p>
</div>

<style>
  #qsl-app {
    --qsl-line: var(--light-grey, #eee);
    --qsl-muted: var(--second-font-color, #999);
    font-size: 0.95em;
  }
  [data-theme='dark'] #qsl-app {
    --qsl-line: rgba(255, 255, 255, 0.12);
  }

  .qsl-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 10px;
    margin-bottom: 18px;
  }
  .qsl-stat {
    border: 1px solid var(--qsl-line);
    border-radius: 8px;
    padding: 10px 12px;
    text-align: center;
  }
  .qsl-stat b {
    display: block;
    font-size: 1.5em;
    line-height: 1.3;
  }
  .qsl-stat span {
    color: var(--qsl-muted);
    font-size: 0.85em;
  }

  .qsl-filters {
    margin-bottom: 14px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .qsl-filters button {
    border: 1px solid var(--qsl-line);
    background: transparent;
    color: inherit;
    border-radius: 999px;
    padding: 4px 14px;
    cursor: pointer;
    font-size: 0.9em;
  }
  .qsl-filters button.active {
    border-color: var(--theme-color, #49b1f5);
    color: var(--theme-color, #49b1f5);
    font-weight: 700;
  }

  .qsl-table-wrap {
    overflow-x: auto;
  }
  .qsl-table {
    width: 100%;
    border-collapse: collapse;
    white-space: nowrap;
  }
  .qsl-table th,
  .qsl-table td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--qsl-line);
    text-align: left;
  }
  .qsl-table td.qsl-note {
    white-space: normal;
    min-width: 200px;
    color: var(--qsl-muted);
  }
  .qsl-call {
    font-family: var(--code-font, monospace);
    font-weight: 700;
  }
  .qsl-date {
    display: block;
    font-size: 0.8em;
    color: var(--qsl-muted);
  }

  .qsl-badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 0.82em;
    border: 1px solid transparent;
  }
  .qsl-badge.done    { color: #2e7d32; border-color: #2e7d32; }
  .qsl-badge.waiting { color: #ef6c00; border-color: #ef6c00; }
  .qsl-badge.owe     { color: #c62828; border-color: #c62828; }
  .qsl-badge.idle    { color: var(--qsl-muted); border-color: var(--qsl-line); }
  [data-theme='dark'] .qsl-badge.done    { color: #81c784; border-color: #81c784; }
  [data-theme='dark'] .qsl-badge.waiting { color: #ffb74d; border-color: #ffb74d; }
  [data-theme='dark'] .qsl-badge.owe     { color: #e57373; border-color: #e57373; }

  .qsl-empty {
    text-align: center;
    color: var(--qsl-muted);
    padding: 24px 0;
  }
</style>

<script>
  (function () {
    var STATUS = {
      done:    { label: '双向完成', cls: 'done' },
      waiting: { label: '待收',     cls: 'waiting' },
      owe:     { label: '欠卡',     cls: 'owe' },
      idle:    { label: '未开始',   cls: 'idle' },
    };

    function statusOf(r) {
      if (r.sent && r.received) return 'done';
      if (r.sent && !r.received) return 'waiting';
      if (!r.sent && r.received) return 'owe';
      return 'idle';
    }

    function esc(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function mark(flag, date) {
      var html = flag ? '✓' : '—';
      if (flag && date) html += '<span class="qsl-date">' + esc(date) + '</span>';
      return html;
    }

    // 排序键：发出/收到日期中较晚的一个，无日期的沉底
    function sortKey(r) {
      var a = r.sent_date || '';
      var b = r.received_date || '';
      return a > b ? a : b;
    }

    function init(records) {
      records.sort(function (a, b) {
        return sortKey(b).localeCompare(sortKey(a));
      });

      var stats = { total: records.length, sent: 0, received: 0, done: 0 };
      records.forEach(function (r) {
        if (r.sent) stats.sent++;
        if (r.received) stats.received++;
        if (statusOf(r) === 'done') stats.done++;
      });
      var rate = stats.total ? Math.round((stats.done / stats.total) * 100) + '%' : '—';

      document.getElementById('qsl-stats').innerHTML = [
        ['总记录', stats.total],
        ['已发出', stats.sent],
        ['已收到', stats.received],
        ['双向完成率', rate],
      ]
        .map(function (p) {
          return '<div class="qsl-stat"><b>' + p[1] + '</b><span>' + p[0] + '</span></div>';
        })
        .join('');

      var filters = [['all', '全部']].concat(
        Object.keys(STATUS).map(function (k) {
          return [k, STATUS[k].label];
        })
      );
      var filterBox = document.getElementById('qsl-filters');
      filterBox.innerHTML = filters
        .map(function (f, i) {
          return (
            '<button data-f="' + f[0] + '"' + (i === 0 ? ' class="active"' : '') + '>' +
            f[1] + '</button>'
          );
        })
        .join('');

      function render(filter) {
        var rows = records.filter(function (r) {
          return filter === 'all' || statusOf(r) === filter;
        });
        document.getElementById('qsl-empty').hidden = rows.length > 0;
        document.getElementById('qsl-tbody').innerHTML = rows
          .map(function (r) {
            var s = STATUS[statusOf(r)];
            return (
              '<tr>' +
              '<td><span class="qsl-badge ' + s.cls + '">' + s.label + '</span></td>' +
              '<td class="qsl-call">' + esc(r.call) + '</td>' +
              '<td>' + mark(r.sent, r.sent_date) + '</td>' +
              '<td>' + mark(r.received, r.received_date) + '</td>' +
              '<td class="qsl-note">' + (r.note ? esc(r.note) : '') + '</td>' +
              '</tr>'
            );
          })
          .join('');
      }

      filterBox.addEventListener('click', function (e) {
        var btn = e.target.closest('button');
        if (!btn) return;
        filterBox.querySelectorAll('button').forEach(function (b) {
          b.classList.remove('active');
        });
        btn.classList.add('active');
        render(btn.dataset.f);
      });

      render('all');
    }

    fetch('/qsl/data.json')
      .then(function (res) { return res.json(); })
      .then(init)
      .catch(function () {
        document.getElementById('qsl-empty').hidden = false;
        document.getElementById('qsl-empty').textContent = '数据加载失败。';
      });
  })();
</script>
