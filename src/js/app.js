import { INITIAL_DATASET } from '../data/questions.js';
import {
  buildSessionQuestions,
  formatPromptHtmlForDisplay,
  gradeAnswer,
  hasUserAnswer,
  questionMatchesSearch,
} from './quiz-engine.js';

const STORAGE_THEME_KEY = 'ocg_trainer_theme_v1';

const TYPE_LABELS = {
  single: 'Один ответ',
  multi: 'Несколько ответов',
  matching: 'Сопоставление',
  text: 'Ввод ответа',
  sequence: 'Последовательность',
  unknown: 'Другой формат',
};

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeRichHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function formatDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} мин ${s} сек` : `${s} сек`;
}

function prepareDataset(raw) {
  const topics = [...(raw.topics || [])].sort((a, b) => {
    if (a.sectionNumber !== null && b.sectionNumber !== null) {
      return a.sectionNumber - b.sectionNumber;
    }
    if (a.sectionNumber !== null) return -1;
    if (b.sectionNumber !== null) return 1;
    return a.title.localeCompare(b.title, 'ru');
  });
  const topicMap = new Map(topics.map((t) => [t.id, t]));
  return {
    topics,
    questions: raw.questions || [],
    topicMap,
  };
}

// --- Application State ---
const standaloneDataset =
  typeof window !== 'undefined' ? window.__STANDALONE_DATASET__ : null;
const isStandaloneBuild = Boolean(standaloneDataset);
const baseDataset = standaloneDataset || INITIAL_DATASET;

const state = {
  theme: localStorage.getItem(STORAGE_THEME_KEY) || 'light',
  mode: 'browse', // 'browse' | 'random' | 'topic'
  dataset: prepareDataset(baseDataset),
  serverAvailable:
    !isStandaloneBuild &&
    typeof window !== 'undefined' &&
    window.location.protocol !== 'file:',

  // Admin auth state (verified by server cookie)
  isAdmin: false,
  passwordConfigured: false,
  loginError: '',
  loginBusy: false,
  importBusy: false,

  // Browse state
  browseTopicId: 'all',
  browseSearch: '',
  browseType: 'all',
  browsePage: 1,
  browsePageSize: 25,

  // Random setup
  randomCount: 20,
  randomShuffleOptions: true,
  randomTopicIds: null,

  // Topic setup
  topicSelectedId: null,
  topicCountMode: 'all', // 'all' | 'custom'
  topicCount: 20,
  topicShuffleQuestions: true,
  topicShuffleOptions: true,

  // Active quiz session (for random or topic)
  session: null,

  // Results review filter
  resultsFilter: 'all', // 'all' | 'wrong'

  // Add section / admin modal
  importOpen: false,
  importLogs: [],
};

function syncTopicSelections(previousTopicIds = new Set()) {
  const allIds = state.dataset.topics.map((t) => t.id);
  if (!state.randomTopicIds) {
    state.randomTopicIds = new Set(allIds);
  } else {
    for (const id of allIds) {
      if (!previousTopicIds.has(id)) {
        state.randomTopicIds.add(id);
      }
    }
    for (const id of [...state.randomTopicIds]) {
      if (!state.dataset.topicMap.has(id)) {
        state.randomTopicIds.delete(id);
      }
    }
  }
  if (!state.topicSelectedId || !state.dataset.topicMap.has(state.topicSelectedId)) {
    state.topicSelectedId = allIds[0] || null;
  }
}

syncTopicSelections();

function applyDataset(rawDataset) {
  const prevIds = new Set(state.dataset.topics.map((t) => t.id));
  state.dataset = prepareDataset(rawDataset);
  syncTopicSelections(prevIds);
}

function applyTheme() {
  document.documentElement.classList.toggle('dark', state.theme === 'dark');
  localStorage.setItem(STORAGE_THEME_KEY, state.theme);
}
applyTheme();

// --- Server API Sync ---
async function fetchServerDataset() {
  if (isStandaloneBuild || window.location.protocol === 'file:') {
    state.serverAvailable = false;
    return;
  }
  try {
    const res = await fetch(`/api/dataset?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.serverAvailable = true;
    const currentData = JSON.stringify({
      topics: state.dataset.topics,
      questions: state.dataset.questions,
    });
    const nextData = JSON.stringify({
      topics: data.topics || [],
      questions: data.questions || [],
    });
    if (currentData !== nextData) {
      applyDataset(data);
      render();
    }
  } catch {
    state.serverAvailable = false;
  }
}

async function fetchAdminStatus() {
  if (isStandaloneBuild || window.location.protocol === 'file:') return;
  try {
    const res = await fetch(`/api/admin/status?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    state.isAdmin = Boolean(data.authenticated);
    state.passwordConfigured = Boolean(data.passwordConfigured);
  } catch {
    // ignore
  }
}

async function submitAdminLogin(password) {
  state.loginBusy = true;
  state.loginError = '';
  render();
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      state.loginError = data.error || 'Неверный пароль';
      state.isAdmin = false;
    } else {
      state.isAdmin = true;
      state.loginError = '';
      await fetchAdminStatus();
    }
  } catch {
    state.loginError = 'Сервер недоступен. Убедитесь, что сайт запущен через Node.js-сервер.';
  } finally {
    state.loginBusy = false;
    render();
  }
}

async function submitAdminLogout() {
  try {
    await fetch('/api/admin/logout', { method: 'POST' });
  } catch {
    // ignore
  }
  state.isAdmin = false;
  state.importLogs = [];
  render();
}

async function handleImportFiles(fileList) {
  const files = [...fileList];
  if (files.length === 0) return;

  state.importBusy = true;
  render();

  try {
    const payloadFiles = await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        html: await file.text(),
      }))
    );

    const res = await fetch('/api/admin/import-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: payloadFiles }),
    });

    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      state.isAdmin = false;
      state.loginError = 'Сессия администратора истекла. Войдите снова.';
      state.importLogs = [];
      return;
    }
    if (!res.ok) {
      state.importLogs = [{ level: 'error', message: data.error || 'Ошибка загрузки на сервер.' }];
      return;
    }

    if (data.dataset) {
      applyDataset(data.dataset);
    }
    state.importLogs = Array.isArray(data.results) ? data.results : [];
  } catch (err) {
    state.importLogs = [{ level: 'error', message: `Ошибка соединения с сервером: ${err.message}` }];
  } finally {
    state.importBusy = false;
    render();
  }
}

async function handleRemoveTopic(topicId) {
  try {
    const res = await fetch(`/api/admin/topics/${encodeURIComponent(topicId)}`, {
      method: 'DELETE',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      state.isAdmin = false;
      state.loginError = 'Сессия администратора истекла. Войдите снова.';
      render();
      return;
    }
    if (res.ok && data.dataset) {
      applyDataset(data.dataset);
      state.importLogs = [{ level: 'ok', message: 'Раздел удалён с сервера и больше не отображается на устройствах.' }];
      render();
    }
  } catch {
    state.importLogs = [{ level: 'error', message: 'Не удалось удалить раздел.' }];
    render();
  }
}

// --- Rendering Helpers ---
function getTopicShort(topicId) {
  const t = state.dataset.topicMap.get(topicId);
  if (!t) return topicId;
  return t.sectionNumber ? `Раздел ${t.sectionNumber}` : t.shortTitle;
}

function renderQuestionImages(q) {
  if (!q.images || q.images.length === 0) return '';
  return `<div class="q-media">${q.images
    .map((src) => `<img src="${escapeHtml(src)}" alt="Изображение к вопросу">`)
    .join('')}</div>`;
}

function renderStatsDetails(q) {
  if (!q.stats) return '';
  if (q.stats.kind === 'votes') {
    const rowsHtml = q.stats.rows
      .map(
        (r) => `<tr>
          <td>${escapeHtml(r.answer)}</td>
          <td class="num"><strong>${r.forVotes}</strong></td>
          <td class="num">${r.againstVotes}</td>
        </tr>`
      )
      .join('');
    return `
      <details class="stats-details">
        <summary>Статистика ответов (За / Против)</summary>
        <div class="stats-table-wrap">
          <table class="stats-table">
            <thead><tr><th>Вариант</th><th class="num">За</th><th class="num">Против</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </details>`;
  }
  if (q.stats.kind === 'choice') {
    const rowsHtml = q.stats.rows
      .map((r) => {
        const isRight = r.verdict === 'Правильно';
        return `<tr>
          <td>${escapeHtml(r.answer)}</td>
          <td class="num">${r.count}</td>
          <td><span class="badge ${isRight ? 'badge-green' : 'badge-red'}">${escapeHtml(r.verdict)}</span></td>
        </tr>`;
      })
      .join('');
    return `
      <details class="stats-details">
        <summary>Статистика ответов (${q.stats.rows.length})</summary>
        <div class="stats-table-wrap">
          <table class="stats-table">
            <thead><tr><th>Ответ</th><th class="num">Выбрали</th><th>Статус</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </details>`;
  }
  if (q.stats.kind === 'matching') {
    const itemsHtml = q.stats.items
      .map(
        (item) => `<div style="margin-bottom:8px;">
          <strong>${escapeHtml(item.left)}</strong>
          <ul style="margin:4px 0 0 18px;padding:0;">
            ${item.entries
              .map(
                (e) =>
                  `<li>${escapeHtml(e.label)} — <span class="badge ${
                    e.verdict === 'Правильно' ? 'badge-green' : 'badge-red'
                  }">${escapeHtml(e.verdict)}</span></li>`
              )
              .join('')}
          </ul>
        </div>`
      )
      .join('');
    return `
      <details class="stats-details">
        <summary>Статистика сопоставления</summary>
        <div class="stats-table-wrap">${itemsHtml}</div>
      </details>`;
  }
  return '';
}

function renderBrowseCard(q, idxOnPage) {
  const promptHtml = sanitizeRichHtml(formatPromptHtmlForDisplay(q));
  const statsNote =
    q.answerSource === 'stats_votes'
      ? '<span class="badge badge-amber" title="В исходном файле галочки не проставлены; ответы определены по большинству голосов За/Против">По статистике За/Против</span>'
      : '';

  let bodyHtml = '';
  if (q.type === 'single' || q.type === 'multi') {
    const isMulti = q.type === 'multi';
    const correctSet = new Set(q.correctIndices);
    bodyHtml = `<div class="options-list">
      ${q.options
        .map((opt, idx) => {
          const isCorrect = correctSet.has(idx);
          return `<div class="option-item ${isCorrect ? 'correct' : ''}">
            <div class="opt-marker ${isMulti ? 'square' : ''}">${isCorrect ? '✓' : ''}</div>
            <div class="opt-text">${sanitizeRichHtml(opt.html) || escapeHtml(opt.text)}</div>
            ${isCorrect ? '<span class="opt-status" style="color:var(--green)">Верно</span>' : ''}
          </div>`;
        })
        .join('')}
    </div>`;
  } else if (q.type === 'matching') {
    bodyHtml = `
      <table class="matching-table">
        <thead><tr><th>Левая часть</th><th>Правильное соответствие</th></tr></thead>
        <tbody>
          ${q.pairs
            .map(
              (p) => `<tr>
                <td>${sanitizeRichHtml(p.leftHtml) || escapeHtml(p.left)}</td>
                <td><strong style="color:var(--green)">${sanitizeRichHtml(p.rightHtml) || escapeHtml(p.right)}</strong></td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
      ${
        q.rightOptions && q.rightOptions.length > 0
          ? `<div style="margin-top:12px;">
              <div style="font-size:13px;font-weight:600;color:var(--text-subtle);">Все варианты правой части:</div>
              <div class="chips">${q.rightOptions.map((o) => `<span class="chip">${escapeHtml(o)}</span>`).join('')}</div>
            </div>`
          : ''
      }
    `;
  } else if (q.type === 'text') {
    bodyHtml = `
      <div class="answer-box">
        <div class="answer-box-title">Правильный ответ${q.acceptedAnswers.length > 1 ? ' (допустимые варианты)' : ''}:</div>
        <div class="chips">${q.acceptedAnswers.map((a) => `<span class="chip chip-correct">${escapeHtml(a)}</span>`).join('')}</div>
      </div>
    `;
  } else if (q.type === 'sequence') {
    bodyHtml = `
      <div class="options-list">
        ${q.items
          .map(
            (item, i) => `<div class="option-item correct">
              <div class="opt-marker square">${i + 1}</div>
              <div class="opt-text">${escapeHtml(item)}</div>
            </div>`
          )
          .join('')}
      </div>
    `;
  } else {
    bodyHtml = `<div class="alert">${sanitizeRichHtml(q.rawHtml || 'Нет структурированных вариантов')}</div>`;
  }

  return `
    <article class="q-card">
      <div class="q-header">
        <div class="q-title">Вопрос ${q.number} <span style="color:var(--text-subtle);font-weight:500;">· #${idxOnPage}</span></div>
        <div class="q-meta">
          <span class="badge badge-primary">${escapeHtml(getTopicShort(q.topicId))}</span>
          <span class="badge">${TYPE_LABELS[q.type] || q.type}</span>
          ${statsNote}
        </div>
      </div>
      <div class="q-body">
        <div class="q-prompt">${promptHtml}</div>
        ${renderQuestionImages(q)}
        ${bodyHtml}
        ${renderStatsDetails(q)}
      </div>
    </article>
  `;
}

// --- Mode 1: Browse ---
function renderBrowseMode() {
  const { topics, questions } = state.dataset;

  const filtered = questions.filter((q) => {
    if (state.browseTopicId !== 'all' && q.topicId !== state.browseTopicId) return false;
    if (state.browseType !== 'all' && q.type !== state.browseType) return false;
    if (state.browseSearch && !questionMatchesSearch(q, state.browseSearch)) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / state.browsePageSize));
  if (state.browsePage > totalPages) state.browsePage = totalPages;
  const start = (state.browsePage - 1) * state.browsePageSize;
  const pageItems =
    state.browsePageSize >= 9999
      ? filtered
      : filtered.slice(start, start + state.browsePageSize);

  const pillsHtml = `
    <button class="topic-pill ${state.browseTopicId === 'all' ? 'active' : ''}" data-browse-topic="all">
      Все темы <span class="count">${questions.length}</span>
    </button>
    ${topics
      .map(
        (t) => `<button class="topic-pill ${state.browseTopicId === t.id ? 'active' : ''}" data-browse-topic="${escapeHtml(t.id)}">
          ${escapeHtml(t.sectionNumber ? `Раздел ${t.sectionNumber}: ${t.shortTitle}` : t.title)}
          <span class="count">${t.actualCount}</span>
        </button>`
      )
      .join('')}
  `;

  const currentTopic =
    state.browseTopicId === 'all' ? null : state.dataset.topicMap.get(state.browseTopicId);

  const paginationHtml =
    filtered.length > 25
      ? `<div class="pagination">
          <button class="btn btn-sm" data-page="${state.browsePage - 1}" ${state.browsePage <= 1 ? 'disabled' : ''}>← Назад</button>
          <span style="font-size:13px;color:var(--text-subtle);">Страница ${state.browsePage} из ${totalPages} (показано ${pageItems.length} из ${filtered.length})</span>
          <button class="btn btn-sm" data-page="${state.browsePage + 1}" ${state.browsePage >= totalPages ? 'disabled' : ''}>Вперёд →</button>
          <button class="btn btn-sm" data-page-size="${state.browsePageSize >= 9999 ? 25 : 9999}">
            ${state.browsePageSize >= 9999 ? 'По 25 на странице' : 'Показать все сразу'}
          </button>
        </div>`
      : '';

  return `
    <section>
      <div class="card card-pad browse-intro" style="margin-bottom:18px;">
        <div class="eyebrow">БАЗА ЗНАНИЙ · ${topics.length} РАЗДЕЛОВ</div>
        <h2 style="margin:0 0 6px;font-size:20px;">Вопросы и правильные ответы</h2>
        <p style="margin:0 0 14px;color:var(--text-subtle);font-size:14px;">
          Изучайте материал по темам или найдите нужный вопрос. Правильные ответы отмечены сразу.
        </p>
        <div class="topic-pills">${pillsHtml}</div>
        <div class="toolbar">
          <input id="browse-search-input" type="search" class="input" placeholder="Поиск по тексту вопроса или ответам..." value="${escapeHtml(state.browseSearch)}">
          <select id="browse-type-select" class="select" aria-label="Фильтр по типу вопроса">
            <option value="all" ${state.browseType === 'all' ? 'selected' : ''}>Все типы вопросов</option>
            <option value="single" ${state.browseType === 'single' ? 'selected' : ''}>Один ответ</option>
            <option value="multi" ${state.browseType === 'multi' ? 'selected' : ''}>Несколько ответов</option>
            <option value="matching" ${state.browseType === 'matching' ? 'selected' : ''}>Сопоставление</option>
            <option value="text" ${state.browseType === 'text' ? 'selected' : ''}>Ввод ответа</option>
            <option value="sequence" ${state.browseType === 'sequence' ? 'selected' : ''}>Последовательность</option>
          </select>
          ${
            state.browseSearch || state.browseType !== 'all' || state.browseTopicId !== 'all'
              ? '<button class="btn" id="browse-reset-btn">Сбросить</button>'
              : '<div></div>'
          }
        </div>
        <div style="font-size:13px;color:var(--text-subtle);">
          ${currentTopic ? `<strong>${escapeHtml(currentTopic.title)}</strong> · ` : ''}Найдено вопросов: <strong>${filtered.length}</strong>
        </div>
      </div>

      ${
        pageItems.length === 0
          ? `<div class="card empty-state">Ничего не найдено по заданным фильтрам.</div>`
          : `<div class="question-list">${pageItems
              .map((q, i) => renderBrowseCard(q, start + i + 1))
              .join('')}</div>`
      }
      ${paginationHtml}
    </section>
  `;
}

// --- Mode 2 & 3 Setup Screens ---
function renderRandomSetup() {
  const { topics, questions } = state.dataset;
  const pool = questions.filter((q) => state.randomTopicIds.has(q.topicId));
  const maxQ = pool.length;
  const presets = [10, 20, 30, 50].filter((n) => n < maxQ);

  return `
    <div class="setup-layout">
      <div class="card card-pad">
        <div class="eyebrow">ПРАКТИКА · ${topics.length} ТЕМ</div>
        <h2 style="margin:0 0 6px;font-size:21px;">Случайный тренажёр по всей базе</h2>
        <p style="margin:0 0 18px;color:var(--text-subtle);font-size:14px;">
          Вопросы выбираются случайно из выбранных тем. Поддерживаются все типы заданий: выбор одного/нескольких вариантов, сопоставление и ввод ответа.
        </p>

        <div style="margin-bottom:18px;">
          <div style="font-weight:700;font-size:14px;margin-bottom:8px;">Количество вопросов (доступно: ${maxQ})</div>
          <div class="preset-row">
            ${presets
              .map(
                (n) => `<button class="preset-btn ${state.randomCount === n ? 'active' : ''}" data-random-count="${n}">${n}</button>`
              )
              .join('')}
            <button class="preset-btn ${state.randomCount >= maxQ && maxQ > 0 ? 'active' : ''}" data-random-count="${maxQ}">Все (${maxQ})</button>
            <input id="random-custom-count" type="number" min="1" max="${Math.max(1, maxQ)}" class="input" style="width:110px;" value="${Math.min(state.randomCount, Math.max(1, maxQ))}" aria-label="Своё количество вопросов">
          </div>
        </div>

        <div class="switch-row">
          <div>
            <div style="font-weight:600;font-size:14px;">Перемешивать варианты ответов</div>
            <div style="font-size:12px;color:var(--text-subtle);">Варианты выбора и правая колонка сопоставления будут идти в случайном порядке</div>
          </div>
          <input id="random-shuffle-opts" type="checkbox" style="width:20px;height:20px;accent-color:var(--primary);" ${state.randomShuffleOptions ? 'checked' : ''}>
        </div>

        <div style="margin-top:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <span style="font-weight:700;font-size:14px;">Темы в выборке</span>
            <span style="display:flex;gap:8px;">
              <button class="btn btn-sm" id="random-topics-all">Все</button>
              <button class="btn btn-sm" id="random-topics-none">Очистить</button>
            </span>
          </div>
          <div class="options-list">
            ${topics
              .map(
                (t) => `<label class="option-item" style="cursor:pointer;padding:10px 12px;">
                  <input type="checkbox" class="random-topic-cb" value="${escapeHtml(t.id)}" style="width:18px;height:18px;accent-color:var(--primary);" ${state.randomTopicIds.has(t.id) ? 'checked' : ''}>
                  <span style="flex:1;font-size:14px;font-weight:600;">${escapeHtml(t.title)}</span>
                  <span class="badge">${t.actualCount} вопр.</span>
                </label>`
              )
              .join('')}
          </div>
        </div>

        <div style="margin-top:20px;display:flex;justify-content:flex-end;">
          <button class="btn btn-primary" id="start-random-btn" ${maxQ === 0 ? 'disabled' : ''}>
            Начать случайный тест (${Math.min(state.randomCount, maxQ)} вопр.)
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderTopicSetup() {
  const { topics, questions } = state.dataset;
  const selectedTopic = state.dataset.topicMap.get(state.topicSelectedId);
  const topicQuestions = selectedTopic
    ? questions.filter((q) => q.topicId === selectedTopic.id)
    : [];
  const maxQ = topicQuestions.length;

  const effectiveCount =
    state.topicCountMode === 'all' ? maxQ : Math.max(1, Math.min(state.topicCount, maxQ));

  return `
    <div class="setup-layout">
      <div class="card card-pad">
        <div class="eyebrow">ВЫБЕРИТЕ НАПРАВЛЕНИЕ</div>
        <h2 style="margin:0 0 6px;font-size:21px;">Тренажёр по темам</h2>
        <p style="margin:0 0 16px;color:var(--text-subtle);font-size:14px;">
          Выберите конкретный раздел и пройдите все вопросы или заданное количество.
        </p>

        <div class="topic-grid" style="margin-bottom:20px;">
          ${topics
            .map((t) => {
              const tqs = questions.filter((q) => q.topicId === t.id);
              const typesCount = {};
              for (const q of tqs) typesCount[q.type] = (typesCount[q.type] || 0) + 1;
              return `<button class="topic-card ${state.topicSelectedId === t.id ? 'selected' : ''}" data-select-topic="${escapeHtml(t.id)}">
                <div class="topic-card-title">${escapeHtml(t.title)}</div>
                <div class="topic-card-meta">
                  <span class="badge badge-primary">${t.actualCount} вопросов</span>
                  ${Object.entries(typesCount)
                    .map(([type, cnt]) => `<span class="badge">${TYPE_LABELS[type] || type}: ${cnt}</span>`)
                    .join('')}
                </div>
              </button>`;
            })
            .join('')}
        </div>

        ${
          selectedTopic
            ? `<div style="border-top:1px solid var(--border);padding-top:16px;">
                <div style="font-weight:700;font-size:14px;margin-bottom:8px;">Сколько вопросов пройти из темы «${escapeHtml(selectedTopic.shortTitle)}»?</div>
                <div class="preset-row" style="margin-bottom:14px;">
                  <button class="preset-btn ${state.topicCountMode === 'all' ? 'active' : ''}" data-topic-mode="all">Все (${maxQ})</button>
                  ${[10, 20, 30]
                    .filter((n) => n < maxQ)
                    .map(
                      (n) => `<button class="preset-btn ${state.topicCountMode === 'custom' && state.topicCount === n ? 'active' : ''}" data-topic-count="${n}">${n}</button>`
                    )
                    .join('')}
                  <input id="topic-custom-count" type="number" min="1" max="${Math.max(1, maxQ)}" class="input" style="width:110px;" value="${effectiveCount}" aria-label="Количество вопросов по теме">
                </div>

                <div class="switch-row">
                  <div>
                    <div style="font-weight:600;font-size:14px;">Перемешивать порядок вопросов</div>
                    <div style="font-size:12px;color:var(--text-subtle);">Если выключено — вопросы пойдут по порядку как в тесте</div>
                  </div>
                  <input id="topic-shuffle-q" type="checkbox" style="width:20px;height:20px;accent-color:var(--primary);" ${state.topicShuffleQuestions ? 'checked' : ''}>
                </div>

                <div class="switch-row">
                  <div>
                    <div style="font-weight:600;font-size:14px;">Перемешивать варианты ответов</div>
                    <div style="font-size:12px;color:var(--text-subtle);">Чтобы запоминать смысл ответа, а не его позицию</div>
                  </div>
                  <input id="topic-shuffle-opts" type="checkbox" style="width:20px;height:20px;accent-color:var(--primary);" ${state.topicShuffleOptions ? 'checked' : ''}>
                </div>

                <div style="margin-top:18px;display:flex;justify-content:flex-end;">
                  <button class="btn btn-primary" id="start-topic-btn" ${maxQ === 0 ? 'disabled' : ''}>
                    Начать тренировку (${effectiveCount} вопр.)
                  </button>
                </div>
              </div>`
            : ''
        }
      </div>
    </div>
  `;
}

// --- Active Quiz Runner ---
function renderQuizQuestionBody(q, userAnswer, gradeResult) {
  const checked = Boolean(gradeResult);
  const promptHtml = sanitizeRichHtml(formatPromptHtmlForDisplay(q));

  let interactiveHtml = '';

  if (q.type === 'single') {
    const correctSet = new Set(q.correctIndices);
    interactiveHtml = `<div class="options-list">
      ${q.displayOptions
        .map((opt, dispIdx) => {
          const isSelected = userAnswer === opt.origIndex;
          const isCorrect = correctSet.has(opt.origIndex);
          let cls = '';
          let marker = String(dispIdx + 1);
          let status = '';
          if (checked) {
            if (isCorrect && isSelected) {
              cls = 'correct';
              marker = '✓';
              status = '<span class="opt-status" style="color:var(--green)">Верно</span>';
            } else if (!isCorrect && isSelected) {
              cls = 'wrong';
              marker = '✗';
              status = '<span class="opt-status" style="color:var(--red)">Ваш выбор</span>';
            } else if (isCorrect) {
              cls = 'missed';
              marker = '✓';
              status = '<span class="opt-status" style="color:var(--green)">Правильный ответ</span>';
            }
          } else if (isSelected) {
            cls = 'selected';
          }
          return `<button type="button" class="option-item ${cls}" data-single-opt="${opt.origIndex}" ${checked ? 'disabled' : ''}>
            <span class="opt-marker">${marker}</span>
            <span class="opt-text">${sanitizeRichHtml(opt.html) || escapeHtml(opt.text)}</span>
            ${status}
          </button>`;
        })
        .join('')}
    </div>`;
  } else if (q.type === 'multi') {
    const selectedSet = new Set(Array.isArray(userAnswer) ? userAnswer : []);
    const correctSet = new Set(q.correctIndices);
    interactiveHtml = `
      <div style="font-size:13px;color:var(--text-subtle);margin-bottom:8px;">Выберите все подходящие варианты:</div>
      <div class="options-list">
      ${q.displayOptions
        .map((opt, dispIdx) => {
          const isSelected = selectedSet.has(opt.origIndex);
          const isCorrect = correctSet.has(opt.origIndex);
          let cls = '';
          let marker = isSelected ? '✓' : String(dispIdx + 1);
          let status = '';
          if (checked) {
            if (isCorrect && isSelected) {
              cls = 'correct';
              marker = '✓';
              status = '<span class="opt-status" style="color:var(--green)">Верно</span>';
            } else if (!isCorrect && isSelected) {
              cls = 'wrong';
              marker = '✗';
              status = '<span class="opt-status" style="color:var(--red)">Лишний</span>';
            } else if (isCorrect && !isSelected) {
              cls = 'missed';
              marker = '✓';
              status = '<span class="opt-status" style="color:var(--green)">Пропущен</span>';
            }
          } else if (isSelected) {
            cls = 'selected';
          }
          return `<button type="button" class="option-item ${cls}" data-multi-opt="${opt.origIndex}" ${checked ? 'disabled' : ''}>
            <span class="opt-marker square">${marker}</span>
            <span class="opt-text">${sanitizeRichHtml(opt.html) || escapeHtml(opt.text)}</span>
            ${status}
          </button>`;
        })
        .join('')}
    </div>`;
  } else if (q.type === 'matching') {
    const chosen = Array.isArray(userAnswer) ? userAnswer : [];
    interactiveHtml = `<div class="matching-rows">
      ${q.pairs
        .map((pair, idx) => {
          const curVal = chosen[idx] || '';
          const rowOk = checked ? gradeResult.rowResults[idx] : null;
          const rowCls = checked ? (rowOk ? 'correct' : 'wrong') : '';
          return `<div class="matching-row ${rowCls}">
            <div class="matching-left">${sanitizeRichHtml(pair.leftHtml) || escapeHtml(pair.left)}</div>
            <div>
              <select class="select matching-select" data-match-idx="${idx}" ${checked ? 'disabled' : ''}>
                <option value="">— Выберите соответствие —</option>
                ${q.displayRightOptions
                  .map(
                    (opt) =>
                      `<option value="${escapeHtml(opt)}" ${curVal === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`
                  )
                  .join('')}
              </select>
              ${
                checked && !rowOk
                  ? `<div class="matching-hint">Правильно: ${escapeHtml(pair.right)}</div>`
                  : ''
              }
            </div>
          </div>`;
        })
        .join('')}
    </div>`;
  } else if (q.type === 'text') {
    const val = typeof userAnswer === 'string' ? userAnswer : '';
    interactiveHtml = `
      <div>
        <label for="quiz-text-input" style="display:block;font-size:13px;font-weight:600;color:var(--text-subtle);margin-bottom:6px;">
          Введите ответ:
        </label>
        <input id="quiz-text-input" type="text" class="input" placeholder="Ваш ответ..." value="${escapeHtml(val)}" ${checked ? 'disabled' : ''} autocomplete="off">
      </div>
    `;
  } else if (q.type === 'sequence') {
    const items = Array.isArray(userAnswer) ? userAnswer : q.displayItems;
    interactiveHtml = `<div class="options-list">
      ${items
        .map((item, idx) => {
          const rowOk = checked ? gradeResult.rowResults[idx] : null;
          const cls = checked ? (rowOk ? 'correct' : 'wrong') : '';
          return `<div class="sequence-row ${cls}">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="opt-marker square">${idx + 1}</span>
              <span>${escapeHtml(item)}</span>
            </div>
            ${
              checked
                ? `<span class="opt-status" style="color:${rowOk ? 'var(--green)' : 'var(--red)'}">
                    ${rowOk ? 'Верно' : `Должно быть #${q.items.indexOf(item) + 1}`}
                  </span>`
                : `<div class="sequence-controls">
                    <button type="button" class="btn btn-sm" data-seq-move="${idx}" data-dir="-1" ${idx === 0 ? 'disabled' : ''}>↑</button>
                    <button type="button" class="btn btn-sm" data-seq-move="${idx}" data-dir="1" ${idx === items.length - 1 ? 'disabled' : ''}>↓</button>
                  </div>`
            }
          </div>`;
        })
        .join('')}
    </div>`;
  }

  let feedbackHtml = '';
  if (checked) {
    if (gradeResult.isCorrect) {
      feedbackHtml = `
        <div class="feedback-banner correct">
          <div class="feedback-title">✓ Правильно!</div>
          ${
            q.type === 'text' && q.acceptedAnswers.length > 1
              ? `<div style="font-size:13px;">Все допустимые варианты: ${q.acceptedAnswers.map((a) => `<code>${escapeHtml(a)}</code>`).join(', ')}</div>`
              : ''
          }
        </div>`;
    } else {
      let correctSummary = '';
      if (q.type === 'single' || q.type === 'multi') {
        const rightTexts = q.correctIndices.map((i) => q.options[i]?.text).filter(Boolean);
        correctSummary = `<div>Правильный ответ: <strong>${rightTexts.map(escapeHtml).join(' / ')}</strong></div>`;
      } else if (q.type === 'text') {
        correctSummary = `<div>Правильный ответ: <span class="chips" style="margin-top:6px;">${q.acceptedAnswers
          .map((a) => `<span class="chip chip-correct">${escapeHtml(a)}</span>`)
          .join('')}</span></div>`;
      } else if (q.type === 'matching') {
        correctSummary = `<div>Проверьте подсвеченные пары выше — правильные соответствия указаны под неверными строками.</div>`;
      } else if (q.type === 'sequence') {
        correctSummary = `<div>Правильный порядок: ${q.items.map((it, i) => `${i + 1}) ${escapeHtml(it)}`).join('; ')}</div>`;
      }
      feedbackHtml = `
        <div class="feedback-banner wrong">
          <div class="feedback-title">✗ Неправильно</div>
          ${correctSummary}
        </div>`;
    }
  }

  return `
    <div class="q-prompt">${promptHtml}</div>
    ${renderQuestionImages(q)}
    ${interactiveHtml}
    ${feedbackHtml}
  `;
}

function renderActiveQuiz() {
  const s = state.session;
  if (s.finished) return renderQuizResults();

  const q = s.questions[s.currentIndex];
  const userAnswer = s.answers[s.currentIndex];
  const gradeResult = s.grades[s.currentIndex];
  const checked = Boolean(gradeResult);

  const answeredCount = s.grades.filter(Boolean).length;
  const correctCount = s.grades.filter((g) => g && g.isCorrect).length;
  const wrongCount = answeredCount - correctCount;
  const progressPct = Math.round((answeredCount / s.questions.length) * 100);
  const canSubmit = hasUserAnswer(q, userAnswer);
  const isLast = s.currentIndex === s.questions.length - 1;

  return `
    <div class="quiz-shell">
      <div class="card quiz-progress-card">
        <div class="quiz-progress-top">
          <div>
            <div style="font-weight:700;font-size:15px;">${escapeHtml(s.title)}</div>
            <div style="font-size:13px;color:var(--text-subtle);">
              Вопрос ${s.currentIndex + 1} из ${s.questions.length}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span class="badge badge-green">✓ ${correctCount}</span>
            <span class="badge badge-red">✗ ${wrongCount}</span>
            <button class="btn btn-sm" id="quiz-finish-early-btn">Завершить</button>
          </div>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${progressPct}%"></div>
        </div>
      </div>

      <article class="q-card">
        <div class="q-header">
          <div class="q-title">Вопрос ${s.currentIndex + 1} <span style="color:var(--text-subtle);font-weight:500;">(в тесте №${q.number})</span></div>
          <div class="q-meta">
            <span class="badge badge-primary">${escapeHtml(getTopicShort(q.topicId))}</span>
            <span class="badge">${TYPE_LABELS[q.type] || q.type}</span>
            ${
              q.answerSource === 'stats_votes'
                ? '<span class="badge badge-amber">По статистике За/Против</span>'
                : ''
            }
          </div>
        </div>
        <div class="q-body">
          ${renderQuizQuestionBody(q, userAnswer, gradeResult)}

          <div class="quiz-actions">
            <button class="btn" id="quiz-prev-btn" ${s.currentIndex === 0 ? 'disabled' : ''}>← Предыдущий</button>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              ${
                !checked
                  ? `<button class="btn btn-primary" id="quiz-check-btn" ${canSubmit ? '' : 'disabled'}>Проверить ответ</button>`
                  : `<button class="btn btn-primary" id="quiz-next-btn">${isLast ? 'Посмотреть итоги →' : 'Следующий вопрос →'}</button>`
              }
            </div>
          </div>
        </div>
      </article>

      <div class="card card-pad">
        <div style="font-size:13px;font-weight:600;color:var(--text-subtle);margin-bottom:10px;">Навигация по вопросам</div>
        <div class="q-nav-dots">
          ${s.questions
            .map((_, idx) => {
              const g = s.grades[idx];
              const cls = [
                idx === s.currentIndex ? 'current' : '',
                g ? (g.isCorrect ? 'correct' : 'wrong') : '',
              ]
                .filter(Boolean)
                .join(' ');
              return `<button type="button" class="q-dot ${cls}" data-jump-q="${idx}">${idx + 1}</button>`;
            })
            .join('')}
        </div>
      </div>
    </div>
  `;
}

function renderQuizResults() {
  const s = state.session;
  const total = s.questions.length;
  const answered = s.grades.filter(Boolean).length;
  const correct = s.grades.filter((g) => g && g.isCorrect).length;
  const wrongIndices = s.questions
    .map((_, idx) => (s.grades[idx] && !s.grades[idx].isCorrect ? idx : -1))
    .filter((idx) => idx !== -1);
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
  const elapsed = formatDuration((s.finishedAt || Date.now()) - s.startedAt);

  const reviewItems = s.questions
    .map((q, idx) => ({ q, idx, ans: s.answers[idx], grade: s.grades[idx] }))
    .filter((item) => {
      if (state.resultsFilter === 'wrong') return !item.grade || !item.grade.isCorrect;
      return true;
    });

  return `
    <div class="quiz-shell">
      <div class="card results-hero">
        <div class="badge badge-primary">${escapeHtml(s.title)}</div>
        <div class="score-big" style="color:${pct >= 70 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--red)'}">${pct}%</div>
        <div style="font-size:17px;font-weight:600;">Правильных ответов: ${correct} из ${total}</div>

        <div class="results-stats">
          <div class="stat-box">
            <div class="stat-val" style="color:var(--green)">${correct}</div>
            <div class="stat-lbl">Верно</div>
          </div>
          <div class="stat-box">
            <div class="stat-val" style="color:var(--red)">${wrongIndices.length}</div>
            <div class="stat-lbl">Ошибок</div>
          </div>
          <div class="stat-box">
            <div class="stat-val">${total - answered}</div>
            <div class="stat-lbl">Пропущено</div>
          </div>
          <div class="stat-box">
            <div class="stat-val" style="font-size:18px;">${elapsed}</div>
            <div class="stat-lbl">Время</div>
          </div>
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center;">
          ${
            wrongIndices.length > 0
              ? `<button class="btn btn-primary" id="retry-mistakes-btn">Повторить ошибки (${wrongIndices.length})</button>`
              : ''
          }
          <button class="btn" id="restart-same-btn">Пройти новую выборку</button>
          <button class="btn" id="back-to-setup-btn">К настройкам</button>
        </div>
      </div>

      <div class="card card-pad">
        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px;">
          <h3 style="margin:0;font-size:17px;">Разбор ответов</h3>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-sm ${state.resultsFilter === 'all' ? 'btn-primary' : ''}" data-res-filter="all">Все (${total})</button>
            <button class="btn btn-sm ${state.resultsFilter === 'wrong' ? 'btn-primary' : ''}" data-res-filter="wrong">Только ошибки (${total - correct})</button>
          </div>
        </div>
        <div class="question-list">
          ${
            reviewItems.length === 0
              ? '<div class="empty-state" style="padding:20px;">Ошибок нет — отличный результат!</div>'
              : reviewItems
                  .map(
                    ({ q, idx, ans, grade }) => `<div class="q-card">
                      <div class="q-header">
                        <div class="q-title">Вопрос ${idx + 1}</div>
                        <div class="q-meta">
                          <span class="badge badge-primary">${escapeHtml(getTopicShort(q.topicId))}</span>
                          ${
                            grade
                              ? `<span class="badge ${grade.isCorrect ? 'badge-green' : 'badge-red'}">${
                                  grade.isCorrect ? '✓ Верно' : '✗ Ошибка'
                                }</span>`
                              : '<span class="badge">Без ответа</span>'
                          }
                        </div>
                      </div>
                      <div class="q-body">
                        ${renderQuizQuestionBody(
                          q,
                          ans,
                          grade || gradeAnswer(q, ans)
                        )}
                      </div>
                    </div>`
                  )
                  .join('')
          }
        </div>
      </div>
    </div>
  `;
}

// --- Admin / Add Section Modal ---
function renderImportModal() {
  if (!state.importOpen) return '';

  if (!state.serverAvailable) {
    return `
      <div class="modal-backdrop" id="import-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Добавление раздела">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;">
            <h2 style="margin:0;font-size:19px;">Добавление раздела</h2>
            <button class="btn btn-sm" id="close-import-btn">✕</button>
          </div>
          <div class="alert alert-amber">
            Сайт сейчас открыт как локальный файл без сервера. Чтобы добавлять разделы с правами администратора и синхронизировать их на всех устройствах, запустите проект на сервере (<code>npm start</code> или через VPS).
          </div>
        </div>
      </div>
    `;
  }

  if (!state.isAdmin) {
    if (!state.passwordConfigured) {
      return `
        <div class="modal-backdrop" id="import-backdrop">
          <div class="modal" role="dialog" aria-modal="true" aria-label="Настройка доступа администратора">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;">
              <h2 style="margin:0;font-size:19px;">Добавление раздела</h2>
              <button class="btn btn-sm" id="close-import-btn">✕</button>
            </div>
            <div class="alert alert-amber">
              Административный доступ пока отключён. Владелец сайта должен задать непустой <code>ADMIN_PASSWORD</code> в переменных окружения сервера или в файле <code>.env</code>, затем перезапустить приложение. Просмотр и тренажёр остаются открытыми.
            </div>
          </div>
        </div>
      `;
    }

    return `
      <div class="modal-backdrop" id="import-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Вход администратора">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;">
            <h2 style="margin:0;font-size:19px;">Вход администратора</h2>
            <button class="btn btn-sm" id="close-import-btn">✕</button>
          </div>

          <p style="margin:0 0 14px;font-size:14px;color:var(--text-subtle);">
            Для добавления или удаления разделов требуется пароль администратора. После загрузки новый раздел сразу появится у всех пользователей на всех устройствах.
          </p>

          ${
            state.loginError
              ? `<div class="alert alert-red" style="margin-bottom:12px;">${escapeHtml(state.loginError)}</div>`
              : ''
          }

          <form id="admin-login-form" style="display:flex;flex-direction:column;gap:12px;">
            <div>
              <label for="admin-password-input" style="display:block;font-size:13px;font-weight:600;margin-bottom:6px;">
                Пароль администратора
              </label>
              <input id="admin-password-input" type="password" class="input" placeholder="Введите пароль..." autocomplete="current-password" required ${state.loginBusy ? 'disabled' : ''}>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;">
              <button type="button" class="btn" id="cancel-login-btn">Отмена</button>
              <button type="submit" class="btn btn-primary" ${state.loginBusy ? 'disabled' : ''}>
                ${state.loginBusy ? 'Проверка...' : 'Войти'}
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  const customTopics = state.dataset.topics.filter((t) => t.isCustom);

  return `
    <div class="modal-backdrop" id="import-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Управление разделами">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <h2 style="margin:0;font-size:19px;">Добавить раздел</h2>
            <span class="badge badge-green">Администратор</span>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-sm" id="admin-logout-btn">Выйти</button>
            <button class="btn btn-sm" id="close-import-btn">✕</button>
          </div>
        </div>

        <div class="alert" style="margin-bottom:14px;">
          Все добавленные здесь разделы сохраняются на сервере и автоматически отображаются на всех устройствах.
        </div>

        <div class="dropzone" id="import-dropzone">
          <div style="font-weight:700;margin-bottom:6px;">
            ${state.importBusy ? 'Загрузка и разбор файлов...' : 'Перетащите один или несколько .html файлов SyncShare сюда'}
          </div>
          <div style="font-size:13px;color:var(--text-subtle);margin-bottom:12px;">
            Поддерживаются страницы «Просмотр вопросов» (один/несколько ответов, сопоставление, ввод текста, последовательность).
          </div>
          <label class="btn btn-primary" style="display:inline-flex;">
            ${state.importBusy ? 'Обработка...' : 'Выбрать HTML-файлы'}
            <input id="import-file-input" type="file" accept=".html,.htm" multiple hidden ${state.importBusy ? 'disabled' : ''}>
          </label>
        </div>

        ${
          state.importLogs.length > 0
            ? `<div style="margin-top:14px;display:flex;flex-direction:column;gap:8px;">
                ${state.importLogs
                  .map(
                    (log) =>
                      `<div class="alert ${
                        log.level === 'error'
                          ? 'alert-red'
                          : log.level === 'warn'
                          ? 'alert-amber'
                          : 'alert-green'
                      }">${escapeHtml(log.message)}</div>`
                  )
                  .join('')}
              </div>`
            : ''
        }

        ${
          customTopics.length > 0
            ? `<div style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px;">
                <div style="font-weight:700;font-size:14px;margin-bottom:8px;">
                  Разделы, добавленные на сервере (${customTopics.length})
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                  ${customTopics
                    .map(
                      (t) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;">
                        <span>${escapeHtml(t.title)} (${t.actualCount} вопр.)</span>
                        <button class="btn btn-sm" data-remove-custom="${escapeHtml(t.id)}">Удалить</button>
                      </div>`
                    )
                    .join('')}
                </div>
              </div>`
            : ''
        }

        <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px;display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;align-items:center;">
          <span style="font-size:12px;color:var(--text-subtle);">
            База синхронизирована с сервером
          </span>
          <button class="btn btn-sm" id="export-json-btn">Скачать базу JSON</button>
        </div>
      </div>
    </div>
  `;
}

// --- Session Launchers ---
function startQuizSession({ title, questions, shuffleQuestions, shuffleOptions }) {
  const sessionQuestions = buildSessionQuestions(questions, {
    count: questions.length,
    shuffleQuestions,
    shuffleOptions,
  });
  const initialAnswers = sessionQuestions.map((q) => {
    if (q.type === 'multi') return [];
    if (q.type === 'matching') return q.pairs.map(() => '');
    if (q.type === 'sequence') return [...q.displayItems];
    if (q.type === 'text') return '';
    return null;
  });

  state.session = {
    title,
    questions: sessionQuestions,
    answers: initialAnswers,
    grades: sessionQuestions.map(() => null),
    currentIndex: 0,
    startedAt: Date.now(),
    finishedAt: null,
    finished: false,
    lastConfig: { title, questions, shuffleQuestions, shuffleOptions },
  };
  state.resultsFilter = 'all';
  render();
}

// --- Main Render & Event Wiring ---
function render() {
  const { topics, questions } = state.dataset;
  const app = document.getElementById('app');

  let mainContent = '';
  if (state.mode === 'browse') {
    mainContent = renderBrowseMode();
  } else if (state.session) {
    mainContent = renderActiveQuiz();
  } else if (state.mode === 'random') {
    mainContent = renderRandomSetup();
  } else if (state.mode === 'topic') {
    mainContent = renderTopicSetup();
  }

  app.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <img
            class="brand-logo"
            src="${typeof window !== 'undefined' && window.__STANDALONE_LOGO__ ? window.__STANDALONE_LOGO__ : './s_guap-sign.svg'}"
            alt="Знак ГУАП"
            width="42"
            height="42"
          >
          <div>
            <div class="brand-title">Тренажёр ОЦГ</div>
            <div class="brand-sub">${topics.length} тем · ${questions.length} вопросов</div>
          </div>
        </div>

        <nav class="mode-tabs" aria-label="Режимы работы">
          <button class="mode-tab ${state.mode === 'browse' ? 'active' : ''}" data-mode="browse">1. Вопросы и ответы</button>
          <button class="mode-tab ${state.mode === 'random' ? 'active' : ''}" data-mode="random">2. Случайный тренажёр</button>
          <button class="mode-tab ${state.mode === 'topic' ? 'active' : ''}" data-mode="topic">3. По темам</button>
        </nav>

        <div class="topbar-actions">
          ${
            isStandaloneBuild
              ? ''
              : `<button class="btn btn-sm" id="open-import-btn">
                  ${state.isAdmin ? '+ Добавить раздел (Админ)' : '+ Добавить раздел'}
                </button>`
          }
          <button class="btn btn-sm btn-icon" id="theme-toggle-btn" title="Переключить тему">
            ${state.theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </div>
    </header>

    <main class="container">
      ${mainContent}
    </main>

    ${renderImportModal()}
  `;

  attachEvents();
}

function attachEvents() {
  // Mode tabs
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-mode');
      if (state.mode !== next) {
        state.mode = next;
        state.session = null;
        render();
      } else if (state.session) {
        state.session = null;
        render();
      }
    });
  });

  // Theme toggle
  document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    render();
  });

  // Add section / Admin modal
  document.getElementById('open-import-btn')?.addEventListener('click', async () => {
    state.importOpen = true;
    state.loginError = '';
    render();
    await fetchAdminStatus();
    render();
    document.getElementById('admin-password-input')?.focus();
  });
  const closeModal = () => {
    state.importOpen = false;
    state.loginError = '';
    render();
  };
  document.getElementById('close-import-btn')?.addEventListener('click', closeModal);
  document.getElementById('cancel-login-btn')?.addEventListener('click', closeModal);
  document.getElementById('import-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'import-backdrop') closeModal();
  });

  document.getElementById('admin-login-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const pwd = document.getElementById('admin-password-input')?.value || '';
    submitAdminLogin(pwd);
  });
  document.getElementById('admin-logout-btn')?.addEventListener('click', submitAdminLogout);

  document.getElementById('import-file-input')?.addEventListener('change', (e) => {
    handleImportFiles(e.target.files);
  });
  const dz = document.getElementById('import-dropzone');
  if (dz) {
    dz.addEventListener('dragover', (e) => {
      e.preventDefault();
      dz.classList.add('dragover');
    });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
      if (e.dataTransfer?.files) handleImportFiles(e.dataTransfer.files);
    });
  }
  document.querySelectorAll('[data-remove-custom]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-remove-custom');
      handleRemoveTopic(id);
    });
  });
  document.getElementById('export-json-btn')?.addEventListener('click', () => {
    const blob = new Blob(
      [JSON.stringify({ topics: state.dataset.topics, questions: state.dataset.questions }, null, 2)],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ocg-questions.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  // Browse events
  document.querySelectorAll('[data-browse-topic]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.browseTopicId = btn.getAttribute('data-browse-topic');
      state.browsePage = 1;
      render();
    });
  });
  const searchInput = document.getElementById('browse-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const pos = e.target.selectionStart;
      state.browseSearch = e.target.value;
      state.browsePage = 1;
      render();
      const el = document.getElementById('browse-search-input');
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  }
  document.getElementById('browse-type-select')?.addEventListener('change', (e) => {
    state.browseType = e.target.value;
    state.browsePage = 1;
    render();
  });
  document.getElementById('browse-reset-btn')?.addEventListener('click', () => {
    state.browseTopicId = 'all';
    state.browseType = 'all';
    state.browseSearch = '';
    state.browsePage = 1;
    render();
  });
  document.querySelectorAll('[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.browsePage = parseInt(btn.getAttribute('data-page'), 10);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      render();
    });
  });
  document.querySelectorAll('[data-page-size]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.browsePageSize = parseInt(btn.getAttribute('data-page-size'), 10);
      state.browsePage = 1;
      render();
    });
  });

  // Random setup events
  document.querySelectorAll('[data-random-count]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.randomCount = parseInt(btn.getAttribute('data-random-count'), 10);
      render();
    });
  });
  document.getElementById('random-custom-count')?.addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10);
    if (Number.isFinite(val) && val >= 1) {
      state.randomCount = val;
      render();
    }
  });
  document.getElementById('random-shuffle-opts')?.addEventListener('change', (e) => {
    state.randomShuffleOptions = e.target.checked;
  });
  document.querySelectorAll('.random-topic-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) state.randomTopicIds.add(cb.value);
      else state.randomTopicIds.delete(cb.value);
      render();
    });
  });
  document.getElementById('random-topics-all')?.addEventListener('click', () => {
    state.randomTopicIds = new Set(state.dataset.topics.map((t) => t.id));
    render();
  });
  document.getElementById('random-topics-none')?.addEventListener('click', () => {
    state.randomTopicIds = new Set();
    render();
  });
  document.getElementById('start-random-btn')?.addEventListener('click', () => {
    const pool = state.dataset.questions.filter((q) => state.randomTopicIds.has(q.topicId));
    const count = Math.max(1, Math.min(state.randomCount, pool.length));
    const picked = buildSessionQuestions(pool, {
      count,
      shuffleQuestions: true,
      shuffleOptions: state.randomShuffleOptions,
    });
    startQuizSession({
      title: `Случайный тренажёр (${picked.length} вопр.)`,
      questions: picked,
      shuffleQuestions: false,
      shuffleOptions: false,
    });
    state.session.lastConfig = {
      title: 'Случайный тренажёр',
      pool,
      count,
      shuffleQuestions: true,
      shuffleOptions: state.randomShuffleOptions,
    };
  });

  // Topic setup events
  document.querySelectorAll('[data-select-topic]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.topicSelectedId = btn.getAttribute('data-select-topic');
      render();
    });
  });
  document.querySelectorAll('[data-topic-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.topicCountMode = btn.getAttribute('data-topic-mode');
      render();
    });
  });
  document.querySelectorAll('[data-topic-count]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.topicCountMode = 'custom';
      state.topicCount = parseInt(btn.getAttribute('data-topic-count'), 10);
      render();
    });
  });
  document.getElementById('topic-custom-count')?.addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10);
    if (Number.isFinite(val) && val >= 1) {
      state.topicCountMode = 'custom';
      state.topicCount = val;
      render();
    }
  });
  document.getElementById('topic-shuffle-q')?.addEventListener('change', (e) => {
    state.topicShuffleQuestions = e.target.checked;
  });
  document.getElementById('topic-shuffle-opts')?.addEventListener('change', (e) => {
    state.topicShuffleOptions = e.target.checked;
  });
  document.getElementById('start-topic-btn')?.addEventListener('click', () => {
    const topic = state.dataset.topicMap.get(state.topicSelectedId);
    if (!topic) return;
    const pool = state.dataset.questions.filter((q) => q.topicId === topic.id);
    const count =
      state.topicCountMode === 'all' ? pool.length : Math.max(1, Math.min(state.topicCount, pool.length));
    const picked = buildSessionQuestions(pool, {
      count,
      shuffleQuestions: state.topicShuffleQuestions,
      shuffleOptions: state.topicShuffleOptions,
    });
    startQuizSession({
      title: topic.title,
      questions: picked,
      shuffleQuestions: false,
      shuffleOptions: false,
    });
    state.session.lastConfig = {
      title: topic.title,
      pool,
      count,
      shuffleQuestions: state.topicShuffleQuestions,
      shuffleOptions: state.topicShuffleOptions,
    };
  });

  // Active Quiz events
  if (state.session && !state.session.finished) {
    const s = state.session;
    const idx = s.currentIndex;
    const q = s.questions[idx];

    document.querySelectorAll('[data-single-opt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (s.grades[idx]) return;
        s.answers[idx] = parseInt(btn.getAttribute('data-single-opt'), 10);
        render();
      });
    });

    document.querySelectorAll('[data-multi-opt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (s.grades[idx]) return;
        const val = parseInt(btn.getAttribute('data-multi-opt'), 10);
        const cur = Array.isArray(s.answers[idx]) ? [...s.answers[idx]] : [];
        const pos = cur.indexOf(val);
        if (pos >= 0) cur.splice(pos, 1);
        else cur.push(val);
        s.answers[idx] = cur;
        render();
      });
    });

    document.querySelectorAll('.matching-select').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        if (s.grades[idx]) return;
        const rowIdx = parseInt(sel.getAttribute('data-match-idx'), 10);
        const cur = Array.isArray(s.answers[idx]) ? [...s.answers[idx]] : q.pairs.map(() => '');
        cur[rowIdx] = e.target.value;
        s.answers[idx] = cur;
        const checkBtn = document.getElementById('quiz-check-btn');
        if (checkBtn) checkBtn.disabled = !hasUserAnswer(q, s.answers[idx]);
      });
    });

    const textInput = document.getElementById('quiz-text-input');
    if (textInput) {
      if (!s.grades[idx]) textInput.focus();
      textInput.addEventListener('input', (e) => {
        s.answers[idx] = e.target.value;
        const checkBtn = document.getElementById('quiz-check-btn');
        if (checkBtn) checkBtn.disabled = !hasUserAnswer(q, s.answers[idx]);
      });
      textInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && hasUserAnswer(q, s.answers[idx]) && !s.grades[idx]) {
          e.preventDefault();
          s.grades[idx] = gradeAnswer(q, s.answers[idx]);
          render();
        }
      });
    }

    document.querySelectorAll('[data-seq-move]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (s.grades[idx]) return;
        const pos = parseInt(btn.getAttribute('data-seq-move'), 10);
        const dir = parseInt(btn.getAttribute('data-dir'), 10);
        const arr = [...s.answers[idx]];
        const target = pos + dir;
        if (target >= 0 && target < arr.length) {
          [arr[pos], arr[target]] = [arr[target], arr[pos]];
          s.answers[idx] = arr;
          render();
        }
      });
    });

    document.getElementById('quiz-check-btn')?.addEventListener('click', () => {
      if (!hasUserAnswer(q, s.answers[idx])) return;
      s.grades[idx] = gradeAnswer(q, s.answers[idx]);
      render();
    });

    document.getElementById('quiz-next-btn')?.addEventListener('click', () => {
      if (idx < s.questions.length - 1) {
        s.currentIndex++;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        s.finished = true;
        s.finishedAt = Date.now();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      render();
    });

    document.getElementById('quiz-prev-btn')?.addEventListener('click', () => {
      if (idx > 0) {
        s.currentIndex--;
        render();
      }
    });

    document.getElementById('quiz-finish-early-btn')?.addEventListener('click', () => {
      s.finished = true;
      s.finishedAt = Date.now();
      render();
    });

    document.querySelectorAll('[data-jump-q]').forEach((btn) => {
      btn.addEventListener('click', () => {
        s.currentIndex = parseInt(btn.getAttribute('data-jump-q'), 10);
        render();
      });
    });
  }

  // Results events
  if (state.session && state.session.finished) {
    const s = state.session;
    document.querySelectorAll('[data-res-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.resultsFilter = btn.getAttribute('data-res-filter');
        render();
      });
    });

    document.getElementById('retry-mistakes-btn')?.addEventListener('click', () => {
      const missed = s.questions.filter((_, idx) => s.grades[idx] && !s.grades[idx].isCorrect);
      if (missed.length === 0) return;
      const cfg = s.lastConfig;
      const rebuilt = buildSessionQuestions(missed, {
        count: missed.length,
        shuffleQuestions: true,
        shuffleOptions: cfg?.shuffleOptions ?? true,
      });
      startQuizSession({
        title: `Работа над ошибками (${rebuilt.length} вопр.)`,
        questions: rebuilt,
        shuffleQuestions: false,
        shuffleOptions: false,
      });
      state.session.lastConfig = cfg;
    });

    document.getElementById('restart-same-btn')?.addEventListener('click', () => {
      const cfg = s.lastConfig;
      if (!cfg) return;
      const picked = buildSessionQuestions(cfg.pool, {
        count: cfg.count,
        shuffleQuestions: cfg.shuffleQuestions,
        shuffleOptions: cfg.shuffleOptions,
      });
      startQuizSession({
        title: cfg.title,
        questions: picked,
        shuffleQuestions: false,
        shuffleOptions: false,
      });
      state.session.lastConfig = cfg;
    });

    document.getElementById('back-to-setup-btn')?.addEventListener('click', () => {
      state.session = null;
      render();
    });
  }
}

// Keyboard shortcuts during active quiz
document.addEventListener('keydown', (e) => {
  if (state.importOpen || !state.session || state.session.finished) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  const s = state.session;
  const idx = s.currentIndex;
  const q = s.questions[idx];
  const checked = Boolean(s.grades[idx]);

  if ((q.type === 'single' || q.type === 'multi') && !checked && /^[1-9]$/.test(e.key)) {
    const pos = parseInt(e.key, 10) - 1;
    if (pos < q.displayOptions.length) {
      const origIdx = q.displayOptions[pos].origIndex;
      if (q.type === 'single') {
        s.answers[idx] = origIdx;
      } else {
        const cur = Array.isArray(s.answers[idx]) ? [...s.answers[idx]] : [];
        const found = cur.indexOf(origIdx);
        if (found >= 0) cur.splice(found, 1);
        else cur.push(origIdx);
        s.answers[idx] = cur;
      }
      render();
    }
  } else if (e.key === 'Enter') {
    if (!checked && hasUserAnswer(q, s.answers[idx])) {
      e.preventDefault();
      s.grades[idx] = gradeAnswer(q, s.answers[idx]);
      render();
    } else if (checked) {
      e.preventDefault();
      if (idx < s.questions.length - 1) s.currentIndex++;
      else {
        s.finished = true;
        s.finishedAt = Date.now();
      }
      render();
    }
  }
});

// Refresh dataset when user returns to tab (if not mid-quiz)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !state.session && !state.importOpen) {
    fetchServerDataset();
  }
});

window.setInterval(() => {
  if (!document.hidden && !state.session && !state.importOpen) {
    fetchServerDataset();
  }
}, 30_000);

render();
fetchServerDataset();
fetchAdminStatus();
